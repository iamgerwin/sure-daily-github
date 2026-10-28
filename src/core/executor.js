import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import CommitHandler from '../github/commit-handler.js';
import IssueHandler from '../github/issue-handler.js';
import AdvancedIssueHandler from '../github/advanced-issue-handler.js';
import logger from '../utils/logger.js';
import { acquireRunLock } from '../utils/run-lock.js';
import config from '../config/loader.js';
import { check as policyCheck, downgradeMode, MODES, DEFAULT_CAPS } from './policy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DECISIONS_FILE = path.join(__dirname, '../../data/pr-maint-decisions.jsonl');
export const BREAKER_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

// The config loader normalizes every dailyTarget to { min, max }, so a plain
// object check would route all issue-mode configs to the advanced handler.
// Only per-repo intervals or a real range need its once-a-day target roll.
// Disabled repositories are never processed, so they must not move the enabled
// ones onto the advanced handler (and its separate issue state file).
export function usesAdvancedIssueHandler(repositories = []) {
  return repositories.some(r =>
    r.enabled !== false
    && (r.intervalMinutes
      || (r.dailyTarget && typeof r.dailyTarget === 'object' && r.dailyTarget.min !== r.dailyTarget.max))
  );
}

// A run that completes but fails some repositories must still exit non-zero,
// otherwise cron and systemd report every failed commit/issue as a success
export function getRunExitCode(result) {
  if (!result?.success) return 1;
  return result.summary?.failed > 0 ? 1 : 0;
}

// One "owner/repo: reason" line per failed repository for the CLI summary
export function describeFailures(results = []) {
  return results
    .filter(r => !r.success)
    .map(r => {
      const error = r.error || r.details?.find(d => d && !d.success)?.error || 'unknown error';
      return `${r.owner}/${r.repo}: ${error}`;
    });
}

class Executor {
  async execute(configOverride = null) {
    let lock;
    try {
      lock = acquireRunLock();
    } catch (error) {
      logger.error('Failed to acquire run lock', { error: error.message });
      return { success: false, error: `Failed to acquire run lock: ${error.message}` };
    }

    if (!lock.acquired) {
      const error = `Another execution is already in progress (pid ${lock.holder?.pid ?? 'unknown'})`;
      logger.warn(error, { holder: lock.holder });
      return { success: false, locked: true, error };
    }

    try {
      return await this.run(configOverride);
    } finally {
      lock.release();
    }
  }

  async run(configOverride = null) {
    const cfg = configOverride || config.get();

    logger.info('Starting execution', {
      mode: cfg.general.mode,
      dryRun: cfg.general.dryRun,
      repositories: cfg.repositories.length
    });

    try {
      // Initialize GitHub client
      const token = config.getGitHubToken();
      const mode = cfg.general.mode || 'commit';

      // Choose handler based on mode
      let handler;
      if (mode === 'issue') {
        if (usesAdvancedIssueHandler(cfg.repositories)) {
          handler = new AdvancedIssueHandler(token);
          logger.info('Using advanced issue handler with randomization');
        } else {
          handler = new IssueHandler(token);
        }
      } else {
        handler = new CommitHandler(token);
      }

      // Validate authentication
      const authResult = await handler.init();
      if (!authResult.success) {
        throw new Error('GitHub authentication failed');
      }

      logger.info('Authenticated with GitHub', { user: authResult.user, mode });

      // Process repositories
      const results = await handler.processRepositories(
        cfg.repositories,
        cfg.contentTemplate,
        cfg.general.dryRun,
        cfg
      );

      // Log summary
      const successful = results.filter(r => r.success && !r.skipped).length;
      const skipped = results.filter(r => r.skipped).length;
      const failed = results.filter(r => !r.success).length;

      logger.info('Execution completed', {
        total: results.length,
        successful,
        skipped,
        failed
      });

      return {
        success: true,
        results,
        summary: { total: results.length, successful, skipped, failed }
      };
    } catch (error) {
      logger.error('Execution failed', { error: error.message });
      return {
        success: false,
        error: error.message
      };
    }
  }

  async getStatus() {
    try {
      const cfg = config.get();
      const token = config.getGitHubToken();
      
      const mode = cfg.general.mode || 'commit';

      // Commit mode tracks progress in StateManager, not the issue state file
      if (mode !== 'issue') {
        const status = await new CommitHandler(token).getStatus(cfg.repositories, cfg.general.timezone);
        return { success: true, status };
      }

      const handler = usesAdvancedIssueHandler(cfg.repositories)
        ? new AdvancedIssueHandler(token)
        : new CommitHandler(token);

      const status = await handler.getStatus(cfg.repositories, cfg.general.timezone);
      return { success: true, status };
    } catch (error) {
      logger.error('Failed to get status', { error: error.message });
      return { success: false, error: error.message };
    }
  }
}

export function decisionsFilePath() {
  return process.env.SDG_PR_MAINT_DECISIONS_FILE || DEFAULT_DECISIONS_FILE;
}

// The mode a tick runs in: a tripped breaker caps the configured mode
export function effectiveMode(configured, breaker, now = Date.now()) {
  if (!breaker || now >= breaker.until) return configured;
  return MODES[Math.min(MODES.indexOf(configured), MODES.indexOf(breaker.to))] || 'shadow';
}

// Same action, same key: a denial is never retried in the same tick
export function actionKey(action) {
  const { body, ...payload } = action.payload || {};
  const bodyHash = body === undefined ? null : crypto.createHash('sha1').update(String(body)).digest('hex');
  return JSON.stringify([action.type, action.scope, action.pr ?? null, action.headSha ?? null, payload, bodyHash]);
}

// What the decisions log keeps of a payload: comment bodies only as a hash
function payloadSummary(payload = {}) {
  const { body, ...rest } = payload;
  if (body === undefined) return rest;
  return { ...rest, bodyBytes: Buffer.byteLength(String(body), 'utf8'), bodySha1: crypto.createHash('sha1').update(String(body)).digest('hex') };
}

// The label effect of an action, so later actions in the tick see it
function applyToLabels(fresh, action) {
  if (!fresh || action.scope !== 'pr') return;
  const label = action.payload?.label;
  if (action.type === 'label.add' && !fresh.labels.includes(label)) fresh.labels = [...fresh.labels, label];
  if (action.type === 'label.remove') fresh.labels = fresh.labels.filter(l => l !== label);
}

const isDashboardWrite = (action) => action.scope === 'dashboard' && action.type === 'comment.upsert';

// Runs pr-maint Actions: every one goes through policy.check first, and every
// verdict is appended to data/pr-maint-decisions.jsonl. Options:
// - mode: effective mode at the start of the tick
// - handlers: { 'type:scope': async (action) => ({ written }) }
// - fresh(number, action): live { headRefOid, state, labels, mergeable, ... } for the head pin
// - state: the pr-maint ledger state (writes, breaker), mutated in place
// - ctx: { owner, authors, caps } for the policy; repo: "owner/repo" for the log
// - dryRun: evaluate and simulate only; nothing is written, not even the log
export class ActionExecutor {
  constructor({ mode, handlers = {}, fresh = null, state, ctx = {}, repo = null, dryRun = false, now = Date.now, decisionsFile = null, policy = policyCheck }) {
    this.mode = mode;
    this.handlers = handlers;
    this.fresh = fresh;
    this.state = state;
    this.ctx = ctx;
    this.repo = repo;
    this.dryRun = dryRun;
    this.now = now;
    this.decisionsFile = decisionsFile || decisionsFilePath();
    this.policy = policy;
    this.denied = new Set();
    this.working = new Map();
    this.prWrites = new Map();
    this.escalations = [];
    this.decisions = [];
  }

  hourWrites() {
    const since = this.now() - HOUR_MS;
    this.state.writes = (this.state.writes || []).filter(at => at > since);
    return this.state.writes.length;
  }

  record(entry) {
    const record = { at: new Date(this.now()).toISOString(), repo: this.repo, mode: this.mode, ...entry };
    this.decisions.push(record);
    if (this.dryRun) return;
    try {
      fs.mkdirSync(path.dirname(this.decisionsFile), { recursive: true });
      fs.appendFileSync(this.decisionsFile, `${JSON.stringify(record)}\n`);
    } catch (error) {
      logger.error('Failed to record pr-maint decision', { error: error.message });
    }
  }

  // Drops the mode one level for 24 hours, effective for the rest of this tick
  trip(verdict, action) {
    const now = this.now();
    const to = downgradeMode(this.mode);
    this.state.breaker = {
      trippedAt: now,
      until: now + BREAKER_MS,
      from: this.mode,
      to,
      reason: `${verdict.rule}: ${verdict.reason}`,
      pr: action.pr ?? null
    };
    logger.warn('pr-maint circuit breaker tripped', { repo: this.repo, from: this.mode, to, rule: verdict.rule, reason: verdict.reason });
    this.mode = to;
    if (verdict.escalate && action.scope === 'pr') {
      this.escalations.push({ pr: action.pr, reason: 'policy-denial', detail: `${verdict.rule}: ${verdict.reason}` });
    }
  }

  // The PR as the policy sees it: live state in act/autonomous mode (the head
  // pin), otherwise the tick's snapshot plus this tick's simulated label changes
  async freshFor(action, snapshotPr) {
    if (action.scope !== 'pr') return null;
    const live = !this.dryRun && this.mode !== 'shadow' && this.fresh;
    if (live) {
      const current = await this.fresh(action.pr, action);
      const merged = { ...snapshotPr, ...current };
      this.working.set(action.pr, merged);
      return merged;
    }
    if (!this.working.has(action.pr)) {
      this.working.set(action.pr, snapshotPr ? { ...snapshotPr, labels: [...snapshotPr.labels] } : null);
    }
    return this.working.get(action.pr);
  }

  // Returns { status: 'done'|'planned'|'denied'|'skipped'|'error', verdict, result, error }
  // cost: the most writes the handler can make (the rate rule reserves it)
  async run(action, { snapshotPr = null, escalation = null, cost = 1 } = {}) {
    const key = actionKey(action);
    const base = { pr: action.pr ?? null, type: action.type, scope: action.scope, headSha: action.headSha ?? null, payload: payloadSummary(action.payload) };
    if (this.denied.has(key)) {
      return { status: 'skipped', reason: 'denied earlier this tick' };
    }

    let fresh;
    try {
      fresh = await this.freshFor(action, snapshotPr);
    } catch (error) {
      this.record({ ...base, verdict: 'error', reason: `fresh read failed: ${error.message}` });
      return { status: 'error', error: error.message };
    }

    let verdict = this.policy(action, fresh, {
      ...this.ctx,
      mode: this.mode,
      escalation,
      now: this.now(),
      cost,
      writes: { pr: this.prWrites.get(action.pr) || 0, hour: this.hourWrites() }
    });
    // Shadow is safe by construction: whatever the policy table says, nothing
    // but the dashboard body is written
    if (verdict.allowed && this.mode === 'shadow' && !isDashboardWrite(action)) {
      verdict = { allowed: false, rule: 'mode', kind: 'deny', reason: 'shadow mode only writes the dashboard issue', trip: false, escalate: false };
    }

    if (!verdict.allowed) {
      this.denied.add(key);
      // A mode denial is the "would have done" record: later actions see its effect
      if (verdict.rule === 'mode') applyToLabels(fresh, action);
      // Logged under the mode it was judged in, before a trip lowers it
      this.record({ ...base, verdict: 'deny', rule: verdict.rule, kind: verdict.kind, reason: verdict.reason });
      // The dashboard is one upsert per tick, never a runaway: at the hourly
      // cap it waits for the budget (the tick fails) instead of keeping the
      // breaker, and with it repository setup, down for another 24 hours
      const paced = verdict.rule === 'rate' && action.scope === 'dashboard';
      if (verdict.trip && !paced) this.trip(verdict, action);
      return { status: 'denied', verdict };
    }

    if (this.dryRun) {
      applyToLabels(fresh, action);
      this.record({ ...base, verdict: 'allow', outcome: 'dry-run' });
      return { status: 'planned', verdict };
    }

    const handler = this.handlers[`${action.type}:${action.scope}`];
    if (!handler) {
      this.record({ ...base, verdict: 'error', reason: 'no handler' });
      return { status: 'error', error: `no handler for ${action.type} on ${action.scope}` };
    }

    try {
      const result = await handler(action);
      const written = result?.written ?? 1;
      if (written > 0) {
        this.prWrites.set(action.pr, (this.prWrites.get(action.pr) || 0) + written);
        this.state.writes = [...(this.state.writes || []), ...Array(written).fill(this.now())];
      }
      applyToLabels(fresh, action);
      this.record({ ...base, verdict: 'allow', outcome: written > 0 ? 'written' : 'unchanged' });
      return { status: 'done', verdict, result };
    } catch (error) {
      logger.error('pr-maint write failed', { repo: this.repo, pr: action.pr, type: action.type, error: error.message });
      this.record({ ...base, verdict: 'allow', outcome: 'error', reason: error.message });
      return { status: 'error', verdict, error: error.message };
    }
  }

  // Repository setup writes (label creates and repairs) are not Actions, but
  // they spend the same hourly budget and stop at the same breaker. At the
  // hourly cap setup only pauses, to be finished on a later tick: a trip would
  // hold it in shadow mode, where setup never runs. Each call is one GitHub
  // write; returns false when it was not admitted.
  async runSetup(what, write) {
    const base = { pr: null, type: 'setup', scope: 'repository', headSha: null, payload: { what } };
    const caps = { ...DEFAULT_CAPS, ...(this.ctx.caps || {}) };
    let verdict = null;
    if (this.mode === 'shadow') {
      verdict = { rule: 'mode', kind: 'deny', reason: 'shadow mode only writes the dashboard issue', trip: false, escalate: false };
    } else if (this.hourWrites() + 1 > caps.writesPerHour) {
      verdict = { rule: 'rate', kind: 'deny', reason: `${caps.writesPerHour} writes in the last hour`, trip: false, escalate: false };
    }
    if (verdict) {
      this.record({ ...base, verdict: 'deny', rule: verdict.rule, kind: verdict.kind, reason: verdict.reason });
      if (verdict.trip) this.trip(verdict, base);
      return false;
    }
    try {
      await write();
    } catch (error) {
      this.record({ ...base, verdict: 'allow', outcome: 'error', reason: error.message });
      throw error;
    }
    this.state.writes = [...(this.state.writes || []), this.now()];
    this.record({ ...base, verdict: 'allow', outcome: 'written' });
    return true;
  }
}

export default new Executor();
