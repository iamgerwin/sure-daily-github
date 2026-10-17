import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import GitHubClient from '../github/client.js';
import { PrMaintGitHub } from '../github/pr-labels.js';
import config from '../config/loader.js';
import logger from '../utils/logger.js';
import { acquireRunLock } from '../utils/run-lock.js';
import { PrMaintLedger, repoState } from '../utils/pr-maint-ledger.js';
import { ActionExecutor, effectiveMode } from './executor.js';
import { isConflicted, selectRepositories, gateReason } from './conflict-fixer.js';
import {
  LIFECYCLE_LABELS, MANAGED_LABELS, NEEDS_HUMAN, BABYSIT, PAUSED, MARKERS, MERGE_POLICY_CONTEXT,
  NEVER_AUTO_CLEAR, NEEDS_HUMAN_CLEAR_LIMIT, NEEDS_HUMAN_WINDOW_MS, DEFAULT_CAPS, MAX_TEXT_BYTES,
  CLEAR_CONDITIONS, clearConditionMet, clearsNeedsHuman
} from './policy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Separate from run.lock: a pr-maint tick must not wait on (or block) `run`
const DEFAULT_LOCK_FILE = path.join(__dirname, '../../data/pr-maint.lock');
// Bump when LABEL_DEFINITIONS change so the labels are repaired once more
export const LABELS_VERSION = 1;
// Denials a later tick may clear by itself, so the PR is decided again
const RETRY_RULES = new Set(['rate', 'head-pin']);

export function prMaintLockFile() {
  return process.env.SDG_PR_MAINT_LOCK_FILE || DEFAULT_LOCK_FILE;
}

export const sha1 = (value) => crypto.createHash('sha1').update(String(value)).digest('hex');
const sameLogin = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const shortSha = (sha) => String(sha || 'none').slice(0, 7);

// Everything that should wake a PR, and nothing we write ourselves: managed
// labels, our status context (left out of `checks`), and our sticky comment
// (an issue comment, which is not part of the snapshot) are excluded. Managed
// labels are reconciled separately against what we last wrote (managedLabels).
export function fingerprint(pr) {
  return sha1(JSON.stringify([
    pr.headRefOid,
    pr.mergeable,
    pr.mergeStateStatus ?? null,
    pr.checks,
    pr.reviewThreads.map(t => `${t.id}:${t.lastCommentId}:${t.isResolved}`).sort(),
    pr.reviews.map(r => r.id).sort(),
    pr.labels.filter(l => !MANAGED_LABELS.includes(l)).sort()
  ]));
}

// Our managed labels on a PR, in a stable order
export function managedLabels(labels) {
  return MANAGED_LABELS.filter(l => labels.includes(l));
}

const sameList = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

export function clearConditionText(reason) {
  return (Object.hasOwn(CLEAR_CONDITIONS, reason) && CLEAR_CONDITIONS[reason].text) || 'a human removes needs-human';
}

// The same allowlisted predicates the needs-human policy rule enforces
export function canAutoClear(escalation, pr, now) {
  if (!escalation?.active || NEVER_AUTO_CLEAR.includes(escalation.reason)) return false;
  if (!clearConditionMet(escalation, pr)) return false;
  const clears = (escalation.clears || []).filter(at => now - at < NEEDS_HUMAN_WINDOW_MS);
  return clears.length < NEEDS_HUMAN_CLEAR_LIMIT;
}

// Records an escalation for the next decide(); the third in 7 days sticks as
// `flapping`. A still-active escalation is kept, not counted twice.
export function recordEscalation(escalations, number, { reason, headSha, detail = null, now }) {
  const key = String(number);
  const prev = escalations[key] || {};
  if (prev.active) return prev;
  const history = (prev.history || []).filter(at => now - at < NEEDS_HUMAN_WINDOW_MS);
  const finalReason = history.length >= NEEDS_HUMAN_CLEAR_LIMIT ? 'flapping' : reason;
  escalations[key] = {
    reason: finalReason,
    detail,
    headSha,
    at: now,
    active: true,
    pending: true,
    history: [...history, now],
    clears: prev.clears || []
  };
  return escalations[key];
}

function waitingNext(pr) {
  if (pr.checks === 'FAILURE') return 'checks are failing';
  if (pr.checks === 'PENDING') return 'waiting for checks';
  const open = pr.reviewThreads.filter(t => !t.isResolved).length;
  if (open) return `${open} unresolved review thread${open === 1 ? '' : 's'}`;
  return 'waiting for the merge policy (ships in a later release)';
}

const LIFECYCLE_WHY = {
  'sdg:fixing': 'addressing review findings',
  'sdg:waiting': 'no open conflict',
  'sdg:ready': 'every merge gate passed'
};

// The lifecycle label a PR should carry. PR2 only moves between conflict and
// waiting; fixing and ready belong to later flows and are kept as found.
export function targetLifecycle(pr) {
  const current = LIFECYCLE_LABELS.filter(l => pr.labels.includes(l));
  if (isConflicted(pr)) {
    return {
      label: 'sdg:conflict',
      why: `merge conflicts with \`${pr.baseRefName}\``,
      next: 'resolve the conflicts (the automatic resolver ships in a later release)'
    };
  }
  if (pr.mergeable === 'UNKNOWN') {
    return { label: current[0] || null, why: 'GitHub has not computed mergeability yet', next: 're-check on the next tick' };
  }
  if (current.includes('sdg:conflict')) {
    return { label: 'sdg:waiting', why: 'the conflict was cleared by a push', next: waitingNext(pr) };
  }
  const label = current[0] || 'sdg:waiting';
  return { label, why: LIFECYCLE_WHY[label], next: label === 'sdg:waiting' ? waitingNext(pr) : 'handled by a later flow' };
}

function describeAction(action) {
  switch (action.type) {
    case 'label.add': return `add label \`${action.payload.label}\``;
    case 'label.remove': return `remove label \`${action.payload.label}\``;
    case 'status.post': return `post \`${MERGE_POLICY_CONTEXT}\` ${action.payload.state} on \`${shortSha(action.headSha)}\``;
    case 'thread.resolve': return 'resolve a review thread';
    default: return action.type;
  }
}

// A function of the PR's state only (no clock, no history), so its hash only
// changes when something worth saying changed, and a lost ledger finds the
// same body already on GitHub
export function renderSticky(pr, row, { mode, owner = null }) {
  const escalation = row.escalation?.active ? row.escalation : null;
  const lines = [
    MARKERS.status,
    `### sdg status: \`${row.lifecycle || 'none'}\``,
    '',
    `- **Why:** ${row.why}`,
    `- **Next step:** ${row.next}`,
    `- **Mode:** \`${mode}\``,
    `- **Head:** \`${shortSha(pr.headRefOid)}\``
  ];
  if (row.priority) lines.push(`- **Priority:** \`${BABYSIT}\` (handled first, twice the per-PR budget)`);
  if (escalation) lines.push(`- **Escalated:** \`${escalation.reason}\`; clears when ${clearConditionText(escalation.reason)}`);
  if (escalation) {
    const clear = clearConditionText(escalation.reason).replace(/\s+/g, '-');
    lines.push('', `<!-- sdg:escalation reason=${escalation.reason} clear=${clear} n=${escalation.history?.length || 1} -->`);
    // The one mention the automation ever writes: the first escalation only
    if (owner && (escalation.history?.length || 1) === 1) lines.push('', `@${owner} this pull request needs a human.`);
  }
  return lines.join('\n');
}

function decidePr(pr, repoLedger, opts) {
  const key = String(pr.number);
  const prev = repoLedger.prs[key] || {};
  const recorded = repoLedger.escalations[key] || null;
  const current = LIFECYCLE_LABELS.filter(l => pr.labels.includes(l));
  const row = {
    number: pr.number,
    headSha: pr.headRefOid,
    priority: pr.labels.includes(BABYSIT) ? 'babysit' : null,
    fingerprint: fingerprint(pr),
    managedLabels: managedLabels(pr.labels),
    escalation: recorded,
    skip: null,
    filtered: false,
    changed: false,
    humanCleared: false,
    delivered: false,
    lifecycle: current[0] || null,
    why: '',
    next: '',
    blocker: null,
    pending: [],
    actions: []
  };

  if (pr.labels.includes(PAUSED)) return { ...row, skip: 'paused', blocker: `\`${PAUSED}\`` };
  if (pr.isCrossRepository) return { ...row, skip: 'fork', blocker: 'head branch is on a fork' };
  if (!(opts.authors || []).some(author => sameLogin(author, pr.author))) {
    return { ...row, skip: 'author', blocker: 'author is not allowlisted' };
  }

  const needsHuman = pr.labels.includes(NEEDS_HUMAN);
  // A pending escalation whose needs-human is already on GitHub was delivered
  // (a crash can lose the ledger write after the label add): acknowledge it
  // first, so a later human clear is honored instead of re-adding the label
  row.delivered = needsHuman && Boolean(recorded?.active && recorded.pending);
  const escalation = row.delivered ? { ...recorded, pending: false } : recorded;
  row.escalation = escalation;
  const clearing = needsHuman && canAutoClear(escalation, pr, opts.now);
  const escalating = !needsHuman && Boolean(escalation?.active && escalation.pending);
  // A human removed our needs-human: the escalation is over
  row.humanCleared = !needsHuman && Boolean(escalation?.active && !escalation.pending);
  const frozen = (needsHuman && !clearing) || escalating;

  if (frozen) {
    const reason = escalation?.active ? escalation.reason : null;
    row.why = reason ? `escalated (\`${reason}\`)` : '`needs-human` was set by a human';
    row.next = `waiting for a human: clears when ${clearConditionText(reason)}`;
    row.blocker = `\`${NEEDS_HUMAN}\`${reason ? ` (${reason})` : ''}`;
  } else {
    const target = targetLifecycle(pr);
    row.lifecycle = target.label;
    row.why = target.why;
    row.next = target.next;
    if (isConflicted(pr)) row.blocker = 'merge conflicts';
    else if (pr.checks === 'FAILURE') row.blocker = 'checks failing';
    else if (pr.isDraft) row.blocker = 'draft';
  }

  const act = (type, payload) => ({ type, scope: 'pr', pr: pr.number, headSha: pr.headRefOid, payload });
  // The label delta is derived from state every tick: in shadow mode it stays
  // put (nothing is applied), which is the dashboard's "would do" column
  const labelActions = [];
  if (escalating) labelActions.push(act('label.add', { label: NEEDS_HUMAN, reason: escalation.reason }));
  if (clearing) labelActions.push(act('label.remove', { label: NEEDS_HUMAN, reason: escalation.reason }));
  if (!frozen && row.lifecycle) {
    // Remove before add so there is never a second lifecycle label
    current.filter(l => l !== row.lifecycle).forEach(l => labelActions.push(act('label.remove', { label: l })));
    if (!current.includes(row.lifecycle)) labelActions.push(act('label.add', { label: row.lifecycle }));
  }
  row.pending = labelActions.map(describeAction);

  if (opts.pr !== null && opts.pr !== undefined && pr.number !== opts.pr) return { ...row, filtered: true };

  // A new escalation record also wakes the PR; once decided (even if shadow
  // mode only logged it) it does not again until something changes. So does
  // a managed label someone else added or removed: the ledger keeps the
  // managed labels as they were after our own writes, which never wake it.
  row.escalationAt = escalation?.at ?? null;
  const labelsMoved = Array.isArray(prev.managedLabels) && !sameList(prev.managedLabels, row.managedLabels);
  row.changed = prev.fingerprint !== row.fingerprint || prev.mode !== opts.mode
    || (prev.escalationAt ?? null) !== row.escalationAt || labelsMoved;
  if (!row.changed) return row;

  const actions = [...labelActions];
  // Commit statuses are per head commit; the snapshot shows whether ours is
  // there. Only a missing status gets the placeholder, never an overwrite.
  if (!frozen && !pr.mergePolicy) {
    actions.push(act('status.post', { context: MERGE_POLICY_CONTEXT, state: 'pending', description: 'Merge policy not evaluated yet' }));
  }

  const sticky = renderSticky(pr, { ...row, escalation: clearing ? null : escalation }, opts);
  if (sha1(sticky) !== prev.stickyHash) actions.push(act('comment.upsert', { marker: 'status', body: sticky }));
  row.actions = actions;
  return row;
}

// Pure: the snapshot plus the repository's ledger slice in, planned actions
// out. opts: { mode, authors, owner, now, pr }. Rows come back babysit first.
export function decide(snapshot, repoLedger, opts) {
  if (snapshot.paused) return { paused: true, prs: [] };
  const ledger = { prs: {}, escalations: {}, ...repoLedger };
  const prs = snapshot.prs.map(pr => decidePr(pr, ledger, opts));
  prs.sort((a, b) => (a.priority ? 0 : 1) - (b.priority ? 0 : 1) || a.number - b.number);
  return { paused: false, prs };
}

export const MAX_DASHBOARD_ROWS = 50;
const utf8Bytes = (text) => Buffer.byteLength(text, 'utf8');

// Bounded to MAX_DASHBOARD_ROWS rows and the policy's MAX_TEXT_BYTES (UTF-8),
// with the omitted count and a link, so it never outgrows the text policy.
// repo: "owner/repo" for the link.
export function renderDashboard(rows, { mode, configuredMode, breaker = null, caps = DEFAULT_CAPS, now, repo = null }) {
  const tripped = breaker && now < breaker.until;
  const lines = [
    MARKERS.dashboard,
    '## sdg: PR automation',
    '',
    `- **Mode:** \`${mode}\`${mode !== configuredMode ? ` (configured \`${configuredMode}\`)` : ''}`,
    `- **Budget:** ${caps.writesPerPrPerTick} writes per PR per tick, ${caps.writesPerHour} writes per hour`,
    // Denial reasons can quote a login; this text must not mention anyone
    `- **Circuit breaker:** ${tripped ? `tripped until ${new Date(breaker.until).toISOString()} (${String(breaker.reason).replace(/@/g, '')})` : 'ok'}`,
    '- **Not automated yet:** conflict resolution, review fixes, merges',
    ''
  ];
  const footer = ['', `Add the \`${PAUSED}\` label to this issue to pause all automation.`];
  if (rows.length === 0) {
    lines.push('No open pull requests.');
    return [...lines, ...footer].join('\n');
  }

  // "Pending" is the label change not applied yet: in shadow mode, what
  // act mode would do
  lines.push('| PR | State | Next step | Blocker | Pending |', '|---|---|---|---|---|');
  const sorted = [...rows].sort((a, b) => a.number - b.number);
  const omittedLine = (n) => `${n} more pull request${n === 1 ? '' : 's'} not listed (the dashboard is capped)`
    + (repo ? `: https://github.com/${repo}/pulls` : '.');
  // Room for the footer and the longest possible omitted line
  let used = utf8Bytes([...lines, ...footer].join('\n')) + utf8Bytes(`\n\n${omittedLine(sorted.length)}`);
  let shown = 0;
  for (const row of sorted) {
    const state = row.skip ? `skipped (${row.skip})` : `\`${row.lifecycle || 'none'}\``;
    const pending = row.pending?.length ? row.pending.join('; ') : '-';
    const line = `| #${row.number} | ${state} | ${row.skip ? '-' : row.next} | ${row.blocker || '-'} | ${pending} |`;
    const size = utf8Bytes(line) + 1;
    if (shown >= MAX_DASHBOARD_ROWS || used + size > MAX_TEXT_BYTES) break;
    lines.push(line);
    used += size;
    shown++;
  }
  if (shown < sorted.length) lines.push('', omittedLine(sorted.length - shown));
  return [...lines, ...footer].join('\n');
}

// Ledger bookkeeping for a write that went through
function applyOutcome(repoLedger, action, result, now) {
  if (action.scope === 'dashboard') {
    repoLedger.dashboard = { number: result?.number ?? repoLedger.dashboard.number ?? null, hash: sha1(action.payload.body) };
    return;
  }
  const key = String(action.pr);
  const entry = repoLedger.prs[key] = repoLedger.prs[key] || {};
  const escalation = repoLedger.escalations[key];
  if (action.type === 'comment.upsert') {
    entry.stickyHash = sha1(action.payload.body);
    entry.stickyCommentId = result?.id ?? entry.stickyCommentId ?? null;
  } else if (action.payload?.label === NEEDS_HUMAN && escalation) {
    if (action.type === 'label.add') escalation.pending = false;
    if (action.type === 'label.remove') {
      escalation.active = false;
      escalation.clears = [...(escalation.clears || []), now];
    }
  }
}

// The dashboard is shadow mode's only output: not publishing it is a failure
const dashboardFailed = (status) => status === 'error' || status === 'denied';

function summarize(results) {
  const summary = { repos: results.length, prs: 0, actions: 0, written: 0, denied: 0, failed: 0 };
  for (const result of results) {
    if (result.error || dashboardFailed(result.dashboard)) summary.failed++;
    for (const pr of result.prs || []) {
      summary.prs++;
      for (const outcome of pr.outcomes || []) {
        summary.actions++;
        if (outcome.status === 'done') summary.written++;
        if (outcome.status === 'denied') summary.denied++;
        if (outcome.status === 'error') summary.failed++;
      }
    }
  }
  return summary;
}

// Like `run`: exits 1 when the tick errored or any repository or write failed
export function getPrMaintExitCode(result) {
  if (!result?.success) return 1;
  return result.summary?.failed > 0 ? 1 : 0;
}

export class PrMaint {
  // options (all injectable for tests): github, ledger, acquireLock, now,
  // token, decisionsFile
  constructor(options = {}) {
    this.options = options;
  }

  now() {
    return (this.options.now || Date.now)();
  }

  async execute(cfg, opts = {}) {
    const acquire = this.options.acquireLock || (() => acquireRunLock({ filePath: prMaintLockFile() }));
    let lock;
    try {
      lock = acquire();
    } catch (error) {
      logger.error('Failed to acquire pr-maint lock', { error: error.message });
      return { success: false, error: `Failed to acquire pr-maint lock: ${error.message}`, results: [], summary: summarize([]) };
    }

    // Cron fires every few minutes; a tick still running just skips this one
    if (!lock.acquired) {
      const error = `Another pr-maint tick is already in progress (pid ${lock.holder?.pid ?? 'unknown'})`;
      logger.warn(error, { holder: lock.holder });
      return { success: true, locked: true, error, results: [], summary: summarize([]) };
    }

    try {
      return await this.run(cfg, opts);
    } finally {
      lock.release();
    }
  }

  async run(cfg, { repos = [], pr = null, mode = null, dryRun = false } = {}) {
    const settings = cfg.prMaint;
    if (!settings.enabled && !dryRun) {
      return { success: true, skipped: true, reason: 'prMaint.enabled is false', results: [], summary: summarize([]) };
    }

    const results = [];
    try {
      const selected = selectRepositories(cfg.repositories, repos);
      const ledger = this.options.ledger || new PrMaintLedger();
      const state = ledger.load();
      const configuredMode = mode || settings.mode;
      const token = this.options.token !== undefined ? this.options.token : null;
      const github = this.options.github || new PrMaintGitHub(new GitHubClient(token || config.getGitHubToken()).octokit);
      const login = await github.whoami();
      const ctx = { settings, state, configuredMode, github, login, pr, dryRun };

      logger.info('Starting pr-maint tick', {
        repositories: selected.length, mode: effectiveMode(configuredMode, state.breaker, this.now()), configuredMode, dryRun
      });

      for (const repoCfg of selected) {
        const { owner, repo } = repoCfg;
        // Same opt-in gate as fix-conflicts: nothing runs on a repository
        // that is not explicitly allowed
        const gate = gateReason(repoCfg, cfg.conflictFixer);
        if (gate) {
          results.push({ owner, repo, success: true, skipped: true, reason: gate, prs: [] });
          continue;
        }
        try {
          results.push(await this.tickRepo(ctx, repoCfg));
        } catch (error) {
          logger.error('pr-maint tick failed for repository', { owner, repo, error: error.message });
          results.push({ owner, repo, success: false, error: error.message, prs: [] });
        }
      }

      if (!dryRun) ledger.save(state);
      const summary = summarize(results);
      logger.info('pr-maint tick completed', summary);
      return {
        success: true,
        dryRun,
        configuredMode,
        mode: effectiveMode(configuredMode, state.breaker, this.now()),
        breaker: state.breaker,
        results,
        summary
      };
    } catch (error) {
      logger.error('pr-maint tick failed', { error: error.message });
      return { success: false, error: error.message, dryRun, results, summary: summarize(results) };
    }
  }

  async tickRepo(ctx, repoCfg) {
    const { owner, repo } = repoCfg;
    const { settings, state, configuredMode, github, login, pr, dryRun } = ctx;
    const snapshot = await github.fetchSnapshot(owner, repo);
    if (snapshot.paused) {
      logger.info('pr-maint paused by the dashboard issue', { owner, repo });
      return { owner, repo, success: true, paused: true, prs: [] };
    }

    const repoLedger = repoState(state, owner, repo);
    const mode = effectiveMode(configuredMode, state.breaker, this.now());
    const caps = { ...DEFAULT_CAPS, ...(settings.rateLimits || {}) };
    const plan = decide(snapshot, repoLedger, { mode, authors: settings.authors, owner: login, pr, now: this.now() });
    const byNumber = new Map(snapshot.prs.map(p => [p.number, p]));

    const dashboardHandler = (action) => github.upsertDashboard(owner, repo, action.payload.body, { number: action.payload.issue });
    // In shadow mode the PR handlers do not even exist
    const handlers = mode === 'shadow'
      ? { 'comment.upsert:dashboard': dashboardHandler }
      : {
        'comment.upsert:dashboard': dashboardHandler,
        'label.add:pr': (a) => github.addLabel(owner, repo, a.pr, a.payload.label),
        'label.remove:pr': (a) => github.removeLabel(owner, repo, a.pr, a.payload.label),
        'comment.upsert:pr': (a) => github.upsertSticky(owner, repo, a.pr, a.payload.body, {
          commentId: repoLedger.prs[String(a.pr)]?.stickyCommentId ?? null
        }),
        'status.post:pr': (a) => github.postStatus(owner, repo, a.headSha, a.payload),
        'thread.resolve:pr': (a) => github.resolveThread(a.payload.threadId)
      };

    const executor = new ActionExecutor({
      mode,
      handlers,
      // Clearing needs-human is judged on live checks too, not the snapshot's
      fresh: (number, action) => github.freshPullRequest(owner, repo, number, { checks: clearsNeedsHuman(action) }),
      state,
      ctx: { owner: login, authors: settings.authors, caps },
      repo: `${owner}/${repo}`,
      dryRun,
      now: () => this.now(),
      decisionsFile: this.options.decisionsFile
    });

    // Repository setup, so never in shadow mode. Every label write is
    // admitted like an Action (hourly cap, breaker); a setup cut short is
    // finished on a later tick.
    if (!dryRun && mode !== 'shadow' && repoLedger.labelsVersion !== LABELS_VERSION) {
      const { complete } = await github.ensureLabels(owner, repo, { write: (what, fn) => executor.runSetup(what, fn) });
      if (complete) repoLedger.labelsVersion = LABELS_VERSION;
    }

    const prResults = [];
    for (const row of plan.prs) {
      const key = String(row.number);
      if (row.delivered && !dryRun) repoLedger.escalations[key].pending = false;
      if (row.humanCleared && !dryRun) repoLedger.escalations[key].active = false;
      const outcomes = [];
      for (const action of row.actions) {
        const outcome = await executor.run(action, {
          snapshotPr: byNumber.get(row.number),
          escalation: repoLedger.escalations[key] || null
        });
        outcomes.push({ action, ...outcome });
        if (outcome.status === 'done') applyOutcome(repoLedger, action, outcome.result, this.now());
      }
      // What was applied is no longer pending (the next snapshot agrees)
      const applied = new Set(outcomes.filter(o => o.status === 'done').map(o => describeAction(o.action)));
      row.pending = row.pending.filter(text => !applied.has(text));
      const unsettled = outcomes.some(o => o.status === 'error' || (o.status === 'denied' && RETRY_RULES.has(o.verdict.rule)));
      if (!dryRun && row.changed && !unsettled) {
        // The managed labels as our own writes left them
        let labels = row.managedLabels;
        for (const { action, status } of outcomes) {
          if (status !== 'done' || action.scope !== 'pr') continue;
          if (action.type === 'label.add') labels = [...labels, action.payload.label];
          if (action.type === 'label.remove') labels = labels.filter(l => l !== action.payload.label);
        }
        repoLedger.prs[key] = {
          ...repoLedger.prs[key], fingerprint: row.fingerprint, mode, escalationAt: row.escalationAt, managedLabels: managedLabels(labels)
        };
      }
      prResults.push({
        number: row.number,
        lifecycle: row.lifecycle,
        skip: row.skip,
        filtered: row.filtered,
        priority: row.priority,
        changed: row.changed,
        pending: row.pending,
        outcomes: outcomes.map(o => ({
          type: o.action.type,
          label: o.action.payload?.label || null,
          detail: describeAction(o.action),
          status: o.status,
          rule: o.verdict?.rule || null,
          reason: o.verdict?.reason || o.reason || o.error || null
        }))
      });
    }

    for (const escalation of executor.escalations) {
      recordEscalation(repoLedger.escalations, escalation.pr, {
        reason: escalation.reason,
        detail: escalation.detail,
        headSha: byNumber.get(escalation.pr)?.headRefOid || null,
        now: this.now()
      });
    }

    // Closed PRs leave the ledger (only a full scan knows which are closed)
    if (pr === null && !dryRun) {
      for (const bucket of [repoLedger.prs, repoLedger.escalations]) {
        for (const key of Object.keys(bucket)) if (!byNumber.has(Number(key))) delete bucket[key];
      }
    }

    // Rendered after the PRs so a breaker trip this tick shows up
    const body = renderDashboard(plan.prs, {
      mode: executor.mode, configuredMode, breaker: state.breaker, caps, now: this.now(), repo: `${owner}/${repo}`
    });
    // The cached hash alone cannot tell that the issue was deleted, closed or
    // edited on GitHub: read it back (no write when it is intact)
    const known = await github.readDashboard(owner, repo, repoLedger.dashboard.number ?? null);
    let dashboard = 'unchanged';
    let dashboardError = null;
    if (known && known.body === body) {
      if (!dryRun) repoLedger.dashboard = { number: known.number, hash: sha1(body) };
    } else {
      const action = {
        type: 'comment.upsert', scope: 'dashboard', pr: null, headSha: null,
        payload: { marker: 'dashboard', body, issue: known?.number ?? null }
      };
      // Creating the issue also pins it: two writes
      const outcome = await executor.run(action, { cost: known ? 1 : 2 });
      if (outcome.status === 'done') applyOutcome(repoLedger, action, outcome.result, this.now());
      dashboard = outcome.status;
      if (dashboardFailed(dashboard)) {
        dashboardError = outcome.verdict?.allowed === false
          ? `${outcome.verdict.rule}: ${outcome.verdict.reason}`
          : outcome.error || 'unknown error';
        logger.error('pr-maint dashboard was not published', { owner, repo, error: dashboardError });
        executor.record({
          pr: null, type: 'dashboard.publish', scope: 'dashboard', headSha: null,
          verdict: 'error', reason: `dashboard not published: ${dashboardError}`
        });
      }
    }

    const failed = prResults.some(p => p.outcomes.some(o => o.status === 'error')) || dashboardFailed(dashboard);
    return { owner, repo, success: !failed, mode: executor.mode, dashboard, dashboardError, prs: prResults };
  }
}

export default new PrMaint();
