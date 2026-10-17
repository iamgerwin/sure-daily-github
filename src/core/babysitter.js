import fs from 'fs';
import os from 'os';
import path from 'path';
import GitHubClient from '../github/client.js';
import config from '../config/loader.js';
import logger from '../utils/logger.js';
import { acquireRunLock } from '../utils/run-lock.js';
import { runGit, gitAuthEnv, scrubEnv } from '../utils/git.js';
import { detectTestCommand, runTestCommand, killActiveTests, tailLines } from '../utils/test-detector.js';
import { BabysitterLedger, MAX_ATTEMPTS, PUSHED_STATE } from '../utils/babysitter-ledger.js';
import { createReviewEngine } from '../utils/review-engine.js';
import { killActiveEngines } from '../utils/process.js';
import { isFreshPushConfig } from './conflict-fixer.js';

// Threat model: the engine runs inside the PR checkout and may execute PR code
// (e.g. `npm test`), as does the test gate. From the moment the engine starts,
// the clone's working tree and .git/config are untrusted. So:
// - the engine and the test gate get scrubEnv(process.env): no GitHub token;
// - every git call disables hooks on the command line and runs with a scrubbed
//   base env, so a planted core.fsmonitor/alias never sees a credential;
// - the token is only used for the initial fetch (before any PR code runs) and
//   for the push, which runs from a fresh bare repository with remote helper
//   protocols locked down and sends the pinned tested SHA, never forced.
const PUSH_BLOCKED_PROTOCOLS = ['ext', 'file', 'git', 'ssh'];

// Appended to every comment babysit posts so its own replies are never triaged
export const REPLY_MARKER = '<!-- sdg-babysit -->';
export const ATTRIBUTION_PATTERN = /Co-Authored-By|Generated with/i;

const ACTION_STATES = { fix: 'addressed', defer: 'deferred', wontfix: 'wontfix', note: 'noted' };
const STATE_LABELS = { addressed: 'fixed', deferred: 'deferred', wontfix: "won't fix", noted: 'noted' };
const MAX_HUNK_CHARS = 2000;
const OUTPUT_TAIL_LINES = 15;
const SIGNALS = ['SIGINT', 'SIGTERM'];

class InterruptedError extends Error {
  constructor() {
    super('babysit run was interrupted');
  }
}

function emptyCounts() {
  return { addressed: 0, deferred: 0, wontfix: 0, noted: 0, failed: 0 };
}

function unwrap(result, what) {
  if (!result?.success) {
    throw new Error(`${what}: ${result?.error || 'unknown error'}`);
  }
  return result.data;
}

// Engine batch failures ({ ids, infra, error }) keyed by comment id
function batchFailureMap(batchFailures = []) {
  return new Map(batchFailures.flatMap(failure => failure.ids.map(id => [id, failure])));
}

const sameLogin = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

// Like `run`: exits 1 when the scan errored or any comment/PR failed this run
export function getBabysitExitCode(result) {
  if (!result?.success) return 1;
  return result.summary?.failed > 0 ? 1 : 0;
}

// Drops Co-Authored-By trailers and "Generated with" footers from a commit message
export function stripAttribution(message) {
  const cleaned = String(message)
    .split('\n')
    .filter(line => !ATTRIBUTION_PATTERN.test(line))
    .join('\n')
    .replace(/\s+$/, '');
  return cleaned ? `${cleaned}\n` : 'fix: address review feedback\n';
}

// GitHub App logins end in "[bot]", which a mention must leave off
export function mentionFor(user) {
  if (user?.type !== 'Bot' || !user.login) return null;
  return `@${user.login.replace(/\[bot\]$/i, '')}`;
}

export function isCrossRepository(pr, owner, repo) {
  const fullName = pr.head?.repo?.full_name;
  return !fullName || fullName.toLowerCase() !== `${owner}/${repo}`.toLowerCase();
}

// Flattens the three comment sources into one list with kind-prefixed ids
// (the endpoints use separate id spaces) and drops comments babysit should not
// answer: empty bodies, pending reviews, its own replies, and the user's own
export function normalizeComments({ reviewComments = [], reviews = [], issueComments = [] }, me = null) {
  const base = (kind, raw) => ({
    id: `${kind}:${raw.id}`,
    kind,
    rawId: raw.id,
    user: raw.user || null,
    author: raw.user?.login || 'unknown',
    body: raw.body || '',
    url: raw.html_url || null,
    path: null,
    line: null,
    diffHunk: null,
    replyToId: null
  });

  const comments = [
    ...reviewComments.map(raw => ({
      ...base('review_comment', raw),
      path: raw.path || null,
      line: raw.line ?? raw.original_line ?? null,
      diffHunk: raw.diff_hunk ? raw.diff_hunk.slice(-MAX_HUNK_CHARS) : null,
      // Replies must target the top-level comment of the thread
      replyToId: raw.in_reply_to_id || raw.id
    })),
    ...reviews.filter(raw => raw.state !== 'PENDING').map(raw => base('review', raw)),
    ...issueComments.map(raw => base('issue_comment', raw))
  ];

  return comments.filter(c =>
    c.body.trim() !== ''
    && !c.body.includes(REPLY_MARKER)
    && !(me && sameLogin(c.author, me.login))
  );
}

export function selectRepositories(repositories, requested = []) {
  if (!requested.length) return repositories.filter(r => r.enabled);

  const selected = [];
  const seen = new Set();
  for (const name of requested) {
    const key = String(name).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const match = repositories.find(r => `${r.owner}/${r.repo}`.toLowerCase() === key);
    if (!match) throw new Error(`Repository ${name} is not configured`);
    if (!match.enabled) throw new Error(`Repository ${name} is disabled in the configuration`);
    selected.push(match);
  }
  return selected;
}

function summarize(results) {
  const summary = { prs: 0, skipped: 0, ...emptyCounts() };
  for (const result of results) {
    if (result.number !== undefined && !result.delivery) summary.prs++;
    if (result.skipped) summary.skipped++;
    if (result.error) summary.failed++;
    for (const key of Object.keys(emptyCounts())) {
      summary[key] += result.counts?.[key] || 0;
    }
  }
  return summary;
}

function formatLocation(location) {
  return location.line ? `${location.path}:${location.line}` : location.path;
}

function fixDetail(comment, decision, fix) {
  const reported = fix.report?.fixes?.find(f => f.id === comment.id);
  const summary = reported?.summary || decision.plan || decision.reasoning;
  const locations = reported?.locations?.length
    ? reported.locations.map(formatLocation)
    : fix.changedFiles;
  const changed = locations.length
    ? `\n\nChanged: ${locations.slice(0, 10).map(l => `\`${l}\``).join(', ')}`
    : '';
  return `Fixed in ${fix.commitSha.slice(0, 12)}: ${summary}${changed}`;
}

// `reReview: false` drops the re-review request for a bot already asked to
// re-review this head elsewhere in the same run
export function inlineReplyBody(comment, decision, fix, { reReview = true } = {}) {
  const mention = mentionFor(comment.user);
  const lead = mention ? `${mention} ` : '';
  let text;
  switch (decision.action) {
    case 'fix': {
      const request = mention ? `${mention} please re-review.` : 'Please re-review.';
      text = reReview ? `${fixDetail(comment, decision, fix)}\n\n${request}` : fixDetail(comment, decision, fix);
      break;
    }
    case 'defer':
      text = `${lead}Deferring this: ${decision.reasoning}${decision.plan ? `\n\nFollow-up: ${decision.plan}` : ''}`;
      break;
    case 'wontfix':
      text = `${lead}Not changing this: ${decision.reasoning}`;
      break;
    default:
      text = `${lead}Noted. ${decision.reasoning}${decision.plan ? `\n\nSee: ${decision.plan}` : ''}`;
  }
  return `${text}\n\n${REPLY_MARKER}`;
}

function giveUpText(error) {
  return `Automated handling failed after ${MAX_ATTEMPTS} attempts (${error}). Leaving this for manual follow-up.`;
}

function giveUpReplyBody(comment, error) {
  const mention = mentionFor(comment.user);
  return `${mention ? `${mention} ` : ''}${giveUpText(error)}\n\n${REPLY_MARKER}`;
}

// One PR comment covering review bodies and issue comments, which (unlike
// inline threads) cannot be replied to individually. Bots are only asked to
// re-review when this run pushed a commit (`fix`), and only those not already
// asked (`asked`) for that head.
export function summaryCommentBody(entries, fix, asked = new Set()) {
  const bots = new Set();
  const lines = entries.map(({ comment, decision, failed, error }) => {
    const mention = mentionFor(comment.user);
    if (mention) bots.add(mention);
    const what = comment.kind === 'review' ? 'review' : 'comment';
    const ref = comment.url ? `[${what}](${comment.url})` : what;
    const prefix = `- ${ref} by \`${comment.author}\``;
    if (failed) return `${prefix}: **failed**: ${giveUpText(error)}`;
    const state = ACTION_STATES[decision.action];
    const detail = decision.action === 'fix' ? fixDetail(comment, decision, fix) : decision.reasoning;
    return `${prefix}: **${STATE_LABELS[state]}**: ${detail.replace(/\n+/g, ' ')}`;
  });

  const parts = ['Babysit update for review feedback on this PR:', '', ...lines];
  const reReview = fix?.commitSha ? [...bots].filter(mention => !asked.has(mention)) : [];
  if (reReview.length) {
    parts.push('', `${reReview.join(' ')} please re-review the latest changes.`);
  }
  parts.push('', REPLY_MARKER);
  return parts.join('\n');
}

function forkNoticeBody(pr, label) {
  const fork = pr.head?.repo?.full_name || 'a deleted fork';
  return [
    `This PR is labeled \`${label}\`, but its head branch lives in ${fork === 'a deleted fork' ? fork : `\`${fork}\``},`,
    'so review fixes cannot be pushed to it automatically. Babysit will skip this PR.',
    '',
    REPLY_MARKER
  ].join('\n');
}

function gitError(args, result) {
  return new Error(`git ${args[0]} failed: ${String(result.stderr || result.stdout).trim()}`);
}

async function isAncestor(run, ancestor, descendant) {
  const args = ['merge-base', '--is-ancestor', ancestor, descendant];
  const result = await run(args);
  if (result.code === 0) return true;
  if (result.code === 1) return false;
  throw gitError(args, result);
}

export class Babysitter {
  // options (all injectable for tests): client, engine, ledger, token, git,
  // runCommand, remoteUrl(owner, repo), tmpDir, acquireLock, killTests,
  // killEngines, exit
  constructor(options = {}) {
    this.options = options;
    this.lock = null;
    this.ctx = null;
    this.activePrKey = null;
    this.activeDirs = new Set();
    this.interrupted = false;
  }

  checkInterrupted() {
    if (this.interrupted) throw new InterruptedError();
  }

  // Engines and test commands run in their own process groups and would
  // outlive this process, still writing to the clone. Kills them (SIGKILL
  // after a grace period), notes the interruption in the ledger, removes the
  // temp dirs, releases the lock, and exits. The current PR's comments were
  // not charged an attempt, and anything already pushed has its replies (or
  // its push intent) in the ledger, so the next run picks up from there. A
  // repeated signal is ignored.
  async interrupt(signal) {
    if (this.interrupted) return;
    this.interrupted = true;
    // Captured now: the main flow unwinds (and clears these) once engines die
    const { activePrKey, ctx } = this;
    logger.warn('Babysit interrupted', { signal, pr: activePrKey });
    (this.options.killTests || killActiveTests)();
    try {
      await (this.options.killEngines || killActiveEngines)();
    } catch (error) {
      logger.error('Failed to stop engine processes', { error: error.message });
    }
    try {
      if (activePrKey && ctx) ctx.ledger.markInterrupted(activePrKey, { signal });
    } catch (error) {
      logger.error('Failed to record the interruption', { error: error.message });
    }
    for (const dir of this.activeDirs) fs.rmSync(dir, { recursive: true, force: true });
    this.activeDirs.clear();
    this.lock?.release();
    (this.options.exit || ((code) => process.exit(code)))(signal === 'SIGINT' ? 130 : 143);
  }

  installSignalHandlers() {
    const handlers = SIGNALS.map(signal => [signal, () => { this.interrupt(signal); }]);
    handlers.forEach(([signal, handler]) => process.on(signal, handler));
    return () => handlers.forEach(([signal, handler]) => process.off(signal, handler));
  }

  get git() {
    return this.options.git || runGit;
  }

  get runCommand() {
    return this.options.runCommand || runTestCommand;
  }

  authEnv(token) {
    return token ? gitAuthEnv(token) : {};
  }

  async execute(cfg, opts = {}) {
    const acquire = this.options.acquireLock || acquireRunLock;
    let lock;
    try {
      lock = acquire();
    } catch (error) {
      logger.error('Failed to acquire run lock', { error: error.message });
      return { success: false, error: `Failed to acquire run lock: ${error.message}`, results: [], summary: summarize([]) };
    }

    // Sharing the executor's lock keeps babysit, `run`, and the scheduler from
    // racing; a busy lock skips this scan rather than failing it
    if (!lock.acquired) {
      const error = `Another execution is already in progress (pid ${lock.holder?.pid ?? 'unknown'})`;
      logger.warn(`${error}, skipping babysit scan`, { holder: lock.holder });
      return { success: true, locked: true, error, results: [], summary: summarize([]) };
    }

    this.lock = lock;
    this.interrupted = false;
    const removeSignalHandlers = this.installSignalHandlers();
    try {
      return await this.run(cfg, opts);
    } finally {
      removeSignalHandlers();
      this.lock = null;
      this.ctx = null;
      lock.release();
    }
  }

  async run(cfg, { repos = [], pr = null, dryRun = false } = {}) {
    const settings = cfg.babysit;
    const results = [];

    try {
      const selected = selectRepositories(cfg.repositories, repos);
      const token = this.options.token !== undefined ? this.options.token : config.getGitHubToken();
      const client = this.options.client || new GitHubClient(token);
      const me = unwrap(await client.getAuthenticatedUser(), 'GitHub authentication failed');
      const ctx = {
        settings,
        client,
        me,
        token,
        dryRun,
        ledger: this.options.ledger || new BabysitterLedger(),
        engine: this.options.engine || createReviewEngine({
          engine: settings.engine,
          model: settings.model,
          timeoutMs: settings.engineTimeoutMinutes * 60 * 1000
        })
      };

      this.ctx = ctx;

      logger.info('Starting babysit scan', {
        repositories: selected.length, label: settings.label, engine: settings.engine, dryRun
      });

      // Replies that failed (or never ran) on an earlier run go out before
      // any new work, without running the engine again
      if (!dryRun) {
        await this.reconcilePushIntents(ctx, selected, pr, results);
        await this.retryDeliveries(ctx, selected, pr, results);
      }

      // Candidates are ordered by the configured repository order (not the
      // --repo order), so the cursor means the same in filtered and full scans
      const repoIndexOf = (name) => cfg.repositories.findIndex(r => `${r.owner}/${r.repo}`.toLowerCase() === name);
      const candidates = [];
      for (const repoCfg of selected) {
        const { owner, repo } = repoCfg;
        const repoIndex = repoIndexOf(`${owner}/${repo}`.toLowerCase());
        try {
          const issues = unwrap(
            await client.listLabeledPullRequests(owner, repo, settings.label),
            `List ${settings.label} pull requests for ${owner}/${repo}`
          );
          issues
            .filter(issue => pr === null || issue.number === pr)
            .filter(issue => !settings.ownPRsOnly || sameLogin(issue.user?.login, me.login))
            .sort((a, b) => a.number - b.number)
            .forEach(issue => candidates.push({ repoCfg, repoIndex, number: issue.number }));
        } catch (error) {
          results.push({ owner, repo, success: false, error: error.message, counts: emptyCounts() });
        }
      }

      // Round-robin: when the budget cannot cover every candidate, start right
      // after the PR the previous scan stopped at, so no PR (idle or not) is
      // starved. Full and --repo/--pr scans share one cursor: a position
      // outside the selected subset just starts it from its first candidate.
      candidates.sort((a, b) => a.repoIndex - b.repoIndex || a.number - b.number);
      const budget = settings.maxPrsPerRun;
      let queue = candidates;
      const cursor = ctx.ledger.getCursor();
      if (cursor && candidates.length > budget) {
        const cursorRepo = repoIndexOf(cursor.repo);
        const start = candidates.findIndex(c =>
          c.repoIndex > cursorRepo || (c.repoIndex === cursorRepo && c.number > cursor.number));
        if (start > 0) queue = [...candidates.slice(start), ...candidates.slice(0, start)];
      }
      queue = queue.slice(0, Math.max(budget, 0));

      for (const { repoCfg, number } of queue) {
        if (this.interrupted) break;
        const { owner, repo } = repoCfg;
        let result;
        try {
          result = await this.processPullRequest(ctx, repoCfg, number);
        } catch (error) {
          logger.error('Babysit failed for pull request', { owner, repo, number, error: error.message });
          result = { success: false, error: error.message, counts: emptyCounts() };
        }
        results.push({ owner, repo, number, ...result });
      }

      if (!dryRun && queue.length && !this.interrupted) {
        const last = queue[queue.length - 1];
        ctx.ledger.setCursor({ repo: `${last.repoCfg.owner}/${last.repoCfg.repo}`.toLowerCase(), number: last.number });
      }
    } catch (error) {
      logger.error('Babysit scan failed', { error: error.message });
      return { success: false, error: error.message, dryRun, results, summary: summarize(results) };
    }

    const summary = summarize(results);
    logger.info('Babysit scan completed', summary);
    return { success: true, dryRun, results, summary };
  }

  async processPullRequest(ctx, repoCfg, number) {
    const { owner, repo } = repoCfg;
    const { client, ledger, settings, me, dryRun } = ctx;
    const counts = emptyCounts();

    // Until it is reconciled, the comments may already be fixed on the branch
    if (ledger.getPushIntent(BabysitterLedger.prKey(owner, repo, number))) {
      return { success: true, skipped: true, reason: 'a push from an earlier run is not reconciled yet', counts };
    }

    const pr = unwrap(await client.getPullRequest(owner, repo, number), `Get pull request #${number}`);
    if (pr.state !== 'open') {
      return { success: true, skipped: true, reason: 'pull request is not open', counts };
    }

    if (isCrossRepository(pr, owner, repo)) {
      const prKey = BabysitterLedger.prKey(owner, repo, number);
      if (!dryRun && !ledger.getPr(prKey)?.forkNotice) {
        const reply = unwrap(
          await client.createIssueComment(owner, repo, number, forkNoticeBody(pr, settings.label)),
          'Post fork notice'
        );
        ledger.markForkNotified(prKey, { replyId: reply.id });
      }
      return { success: true, skipped: true, reason: 'head branch is on a fork and cannot be pushed to', counts };
    }

    const comments = normalizeComments({
      reviewComments: unwrap(await client.listReviewComments(owner, repo, number), 'List review comments'),
      reviews: unwrap(await client.listReviews(owner, repo, number), 'List reviews'),
      issueComments: unwrap(await client.listIssueComments(owner, repo, number), 'List issue comments')
    }, me);
    const pending = comments.filter(c =>
      ledger.shouldProcess(BabysitterLedger.commentKey(owner, repo, number, c.id)));
    if (pending.length === 0) {
      return { success: true, skipped: true, reason: 'no new review comments', counts };
    }

    logger.info('Babysitting pull request', { owner, repo, number, comments: pending.length });
    this.activePrKey = BabysitterLedger.prKey(owner, repo, number);
    try {
      const workspace = await this.prepareWorkspace(ctx, repoCfg, pr);
      try {
        if (workspace.headMoved) {
          return { success: true, skipped: true, reason: 'PR head moved during the scan; retrying next run', counts };
        }
        return await this.handleComments(ctx, repoCfg, pr, pending, workspace, counts);
      } finally {
        workspace.cleanup();
      }
    } finally {
      this.activePrKey = null;
    }
  }

  // Fresh clone of the PR head in a temp dir. Hooks are disabled for every git
  // call on the command line, and in the clone's config for the engine's own
  // commits. `run` resolves { code, stdout, stderr }; `git` throws on non-zero.
  async prepareWorkspace(ctx, repoCfg, pr) {
    const { owner, repo } = repoCfg;
    const headRef = pr.head.ref;
    const baseRef = pr.base.ref;
    const workRoot = this.options.tmpDir || os.tmpdir();
    const root = fs.mkdtempSync(path.join(workRoot, 'sdg-babysit-'));
    this.activeDirs.add(root);
    const cleanup = () => {
      fs.rmSync(root, { recursive: true, force: true });
      this.activeDirs.delete(root);
    };

    try {
      const dir = path.join(root, 'repo');
      const run = (args, opts = {}) => this.git(['-c', `core.hooksPath=${os.devNull}`, ...args], {
        cwd: dir, env: {}, baseEnv: scrubEnv(process.env), ...opts
      });
      const git = async (args, opts) => {
        const result = await run(args, opts);
        if (result.code !== 0) throw gitError(args, result);
        return result.stdout;
      };
      const remoteUrl = this.options.remoteUrl
        ? this.options.remoteUrl(owner, repo)
        : `https://github.com/${owner}/${repo}.git`;
      const email = ctx.me.id
        ? `${ctx.me.id}+${ctx.me.login}@users.noreply.github.com`
        : `${ctx.me.login}@users.noreply.github.com`;

      await git(['init', '-q', dir], { cwd: root });
      await git(['config', 'core.hooksPath', os.devNull]);
      await git(['config', 'user.name', ctx.me.login]);
      await git(['config', 'user.email', email]);
      await git(['config', 'commit.gpgsign', 'false']);
      await git(['remote', 'add', 'origin', remoteUrl]);

      // No PR code has run yet, so the clone's config is still ours
      const refspecs = [`+refs/heads/${headRef}:refs/remotes/origin/${headRef}`];
      if (baseRef !== headRef) refspecs.push(`+refs/heads/${baseRef}:refs/remotes/origin/${baseRef}`);
      await git(['fetch', '-q', '--no-tags', 'origin', ...refspecs], { env: this.authEnv(ctx.token) });

      const remoteHead = (await git(['rev-parse', `refs/remotes/origin/${headRef}`])).trim();
      const workspace = {
        root,
        dir,
        run,
        git,
        cleanup,
        workRoot,
        remoteUrl,
        headSha: pr.head.sha,
        scratch: path.join(dir, '.sdg-babysit'),
        headMoved: remoteHead !== pr.head.sha
      };
      if (workspace.headMoved) return workspace;

      await git(['checkout', '-q', '-B', headRef, pr.head.sha]);
      // Engine I/O files live in the checkout (engines may not write outside it)
      // but are excluded so they never dirty the tree or get committed
      fs.mkdirSync(path.join(dir, '.git', 'info'), { recursive: true });
      fs.appendFileSync(path.join(dir, '.git', 'info', 'exclude'), '\n/.sdg-babysit/\n');
      fs.mkdirSync(workspace.scratch, { recursive: true });

      workspace.diff = async () => {
        const result = await run(['diff', `refs/remotes/origin/${baseRef}...HEAD`]);
        return result.code === 0 ? result.stdout : '';
      };
      workspace.resetToHead = async () => {
        await git(['reset', '-q', '--hard', pr.head.sha]);
        await git(['clean', '-q', '-fd']);
      };
      return workspace;
    } catch (error) {
      cleanup();
      throw error;
    }
  }

  async handleComments(ctx, repoCfg, pr, pending, workspace, counts) {
    const { owner, repo } = repoCfg;
    const prInfo = {
      number: pr.number,
      title: pr.title || '',
      repoFullName: `${owner}/${repo}`,
      headRef: pr.head.ref,
      baseRef: pr.base.ref
    };

    const triage = await ctx.engine.triage({
      cwd: workspace.dir,
      pr: prInfo,
      comments: pending,
      diff: await workspace.diff(),
      outputFile: path.join(workspace.scratch, 'triage.json'),
      env: scrubEnv(process.env)
    });
    this.checkInterrupted();
    // Triage is read-only; discard anything the engine changed anyway
    await workspace.resetToHead();

    const plan = [];
    const failures = [];
    // Not charged an attempt: the engine could not start, the push raced
    // another push, or the implement report did not cover the comment
    const retrying = [];
    if (!triage.ok && triage.infra && !triage.batchFailures) {
      for (const comment of pending) retrying.push({ comment, error: `triage failed: ${triage.error}` });
    } else if (!triage.ok && !triage.batchFailures) {
      for (const comment of pending) failures.push({ comment, action: null, error: `triage failed: ${triage.error}` });
    } else {
      const byId = new Map((triage.decisions || []).map(d => [d.id, d]));
      // A failed triage batch only affects its own comments, also when every
      // batch failed
      const failedBatch = batchFailureMap(triage.batchFailures);
      for (const comment of pending) {
        const batch = failedBatch.get(comment.id);
        const decision = byId.get(comment.id);
        if (batch?.infra) retrying.push({ comment, error: `triage failed: ${batch.error}` });
        else if (batch) failures.push({ comment, action: null, error: `triage failed: ${batch.error}` });
        else if (decision) plan.push({ comment, decision });
        else failures.push({ comment, action: null, error: 'triage returned no decision for this comment' });
      }
    }

    if (ctx.dryRun) {
      return {
        success: triage.ok,
        dryRun: true,
        error: triage.ok ? undefined : `triage failed: ${triage.error}`,
        counts,
        planned: plan.map(({ comment, decision }) => ({
          id: comment.id,
          author: comment.author,
          url: comment.url,
          action: decision.action,
          reasoning: decision.reasoning,
          plan: decision.plan
        })),
        undecided: failures.map(f => f.comment.id)
      };
    }

    const fixItems = plan.filter(p => p.decision.action === 'fix');
    // Only an explicit "implemented" settles a fix; an explicit "failed" (or
    // a failed gate/push, or a genuinely failed engine batch) is charged an
    // attempt; an id the report left out or contradicted stays pending
    const outcomes = (fix) => {
      const reported = new Map((fix.report?.fixes || []).map(f => [f.id, f]));
      const conflicting = new Set(fix.report?.conflicting || []);
      const failedBatch = batchFailureMap(fix.report?.batchFailures);
      const fixed = new Set();
      const fixFailures = [];
      const fixRetrying = [];
      for (const item of fixItems) {
        const { comment } = item;
        const entry = reported.get(comment.id);
        const batch = failedBatch.get(comment.id);
        if (batch?.infra) {
          fixRetrying.push({ comment, error: `engine failed: ${batch.error}` });
        } else if (batch) {
          fixFailures.push({ comment, action: 'fix', error: `engine failed: ${batch.error}` });
        } else if (fix.infra || fix.reschedule || (fix.report && !entry)) {
          const uncovered = conflicting.has(comment.id)
            ? 'implement report gave conflicting statuses for this comment'
            : 'implement report did not cover this comment';
          fixRetrying.push({ comment, reschedule: Boolean(fix.reschedule), error: entry || !fix.report ? fix.error : uncovered });
        } else if (fix.ok && entry.status === 'implemented') {
          fixed.add(item);
        } else {
          const error = fix.ok ? `engine could not fix this: ${entry.summary || 'no reason given'}` : fix.error;
          fixFailures.push({ comment, action: 'fix', error });
        }
      }
      return {
        settled: plan.filter(p => p.decision.action !== 'fix' || fixed.has(p)),
        failures: [...failures, ...fixFailures],
        retrying: fixRetrying
      };
    };

    const prKey = BabysitterLedger.prKey(owner, repo, pr.number);
    let fix = null;
    let outcome = { settled: plan, failures, retrying: [] };
    if (fixItems.length) {
      // Everything the replies need, stored before the remote push so a run
      // that dies right after it can still settle (see reconcilePushIntents)
      const beforePush = (pushed) => {
        const expected = outcomes(pushed);
        ctx.ledger.recordPushIntent(prKey, {
          owner, repo, pr: pr.number,
          expectedSha: pushed.commitSha,
          sourceHead: workspace.headSha,
          settled: expected.settled,
          failures: expected.failures,
          fix: pushed
        });
      };
      try {
        fix = await this.applyFixes(ctx, repoCfg, pr, prInfo, workspace, fixItems, beforePush);
      } catch (error) {
        if (error instanceof InterruptedError) throw error;
        fix = { ok: false, error: error.message };
      }
      // An interrupted run keeps its push intent for the next run to reconcile
      this.checkInterrupted();
      if (!fix.ok && !fix.reschedule && ctx.ledger.getPushIntent(prKey)) {
        // The push was attempted and errored, but it may still have landed:
        // nothing is settled or charged until the next run checks the head
        const failed = outcomes(fix);
        ctx.ledger.markPushUnconfirmed(prKey, { error: fix.error, settled: failed.settled, failures: failed.failures });
        logger.warn('Babysit push outcome unknown; reconciling next run', { owner, repo, number: pr.number, error: fix.error });
        return {
          success: false,
          error: `push outcome unknown (${fix.error}); reconciling next run`,
          counts,
          commitSha: null,
          failures: [],
          retrying: pending.map(comment => ({ id: comment.id, error: fix.error }))
        };
      }
      if (!fix.ok) {
        ctx.ledger.clearPushIntent(prKey);
        logger.warn('Babysit fix was not pushed', { owner, repo, number: pr.number, error: fix.error });
      } else {
        logger.info('Babysit fix pushed', { owner, repo, number: pr.number, commit: fix.commitSha });
      }
      outcome = outcomes(fix);
    }

    const allRetrying = [...retrying, ...outcome.retrying];
    // A push race is not a failure: the comment is retried against the new head
    for (const item of allRetrying) if (!item.reschedule) counts.failed++;
    await this.postReplies(ctx, repoCfg, pr, workspace.headSha, outcome.settled, outcome.failures, fix?.ok ? fix : null, counts);

    return {
      success: counts.failed === 0,
      counts,
      commitSha: fix?.ok ? fix.commitSha : null,
      failures: outcome.failures.map(f => ({ id: f.comment.id, error: f.error })),
      retrying: allRetrying.map(r => ({ id: r.comment.id, error: r.error }))
    };
  }

  // Runs the engine, then commits, verifies, tests, and pushes. The report
  // travels with every outcome so the caller knows which items it covered.
  // `beforePush(fix)` gets the would-be pushed fix right before the push.
  async applyFixes(ctx, repoCfg, pr, prInfo, workspace, fixItems, beforePush = null) {
    const implement = await ctx.engine.implement({
      cwd: workspace.dir,
      pr: prInfo,
      items: fixItems,
      reportFile: path.join(workspace.scratch, 'implement.json'),
      env: scrubEnv(process.env)
    });
    this.checkInterrupted();
    if (!implement.ok) {
      // Per-batch failures still decide, item by item, what is charged
      const report = implement.batchFailures ? { fixes: [], batchFailures: implement.batchFailures } : undefined;
      return { ok: false, infra: Boolean(implement.infra), error: `engine failed: ${implement.error}`, report };
    }
    const report = implement.report;
    if (!report || !Array.isArray(report.fixes)) {
      return { ok: false, infra: true, error: 'engine did not write a valid implement report' };
    }
    if (!report.fixes.some(f => f.status === 'implemented')) {
      return { ok: false, report, error: 'engine reported no fix as implemented' };
    }

    const result = await this.verifyAndPush(ctx, repoCfg, pr, workspace, (pushed) => beforePush?.({ ...pushed, report }));
    return { ...result, report };
  }

  async verifyAndPush(ctx, repoCfg, pr, workspace, beforePush = null) {
    const { git, run, dir, headSha } = workspace;

    // Engines that may not commit (claude without the git allowlist) can edit
    // files but leave them uncommitted, so leftovers are committed here
    if ((await git(['status', '--porcelain'])).trim()) {
      await git(['add', '-A']);
      await git(['commit', '-q', '--no-verify', '-m', `fix: address review feedback on #${pr.number}`]);
    }

    const head = (await git(['rev-parse', 'HEAD'])).trim();
    if (head === headSha) return { ok: false, error: 'engine made no changes' };
    if (!(await isAncestor(run, headSha, head))) {
      return { ok: false, error: 'engine rewrote existing PR history' };
    }
    const lines = (await git(['rev-list', '--reverse', '--parents', `${headSha}..${head}`]))
      .trim().split('\n').filter(Boolean);
    if (lines.some(line => line.split(' ').length > 2)) {
      return { ok: false, error: 'engine created merge commits' };
    }

    const finalHead = await this.stripCommitAttribution(workspace, headSha, lines.map(line => line.split(' ')[0]));
    const messages = await git(['log', '--format=%B', `${headSha}..${finalHead}`]);
    if (ATTRIBUTION_PATTERN.test(messages)) {
      return { ok: false, error: 'commit messages still contain attribution' };
    }
    if ((await git(['status', '--porcelain'])).trim()) {
      return { ok: false, error: 'working tree is not clean after committing' };
    }

    const gate = await this.runTestGate(ctx, repoCfg, dir);
    if (!gate.ok) return gate;

    // Tests ran PR code with write access to the clone; only the exact commit
    // they ran against may be pushed. Untracked files (node_modules) are fine.
    const tested = await run(['rev-parse', 'HEAD']);
    if (tested.code !== 0 || String(tested.stdout).trim() !== finalHead) {
      return { ok: false, error: 'tests moved HEAD away from the tested commit' };
    }
    for (const args of [['diff', '--quiet'], ['diff', '--cached', '--quiet']]) {
      if ((await run(args)).code !== 0) {
        return { ok: false, error: 'tests modified tracked files' };
      }
    }

    const changedFiles = (await git(['diff', '--name-only', headSha, finalHead])).trim().split('\n').filter(Boolean);
    this.checkInterrupted();
    const fix = { ok: true, commitSha: finalHead, changedFiles };
    beforePush?.(fix);
    const pushed = await this.pushPinned(ctx, workspace, finalHead, pr.head.ref);
    if (!pushed.ok) return pushed;

    return fix;
  }

  // Same pattern as fix-conflicts: the authenticated push runs from a fresh
  // bare repository whose config the PR code never saw, sends the pinned SHA
  // (not HEAD), and is never forced, so it only fast-forwards. mkdtemp makes
  // its path unpredictable, so PR code cannot plant a repository there.
  async pushPinned(ctx, workspace, sha, headRef) {
    const { run, git, remoteUrl } = workspace;
    const pushDir = fs.mkdtempSync(path.join(workspace.workRoot, 'sdg-babysit-push-'));
    this.activeDirs.add(pushDir);
    try {
      await git(['init', '-q', '--bare', pushDir], { cwd: pushDir });
      // Runs with the untrusted clone config, but without any credential
      await git(['push', '-q', pushDir, `${sha}:refs/heads/${headRef}`]);
      if (!isFreshPushConfig(await run(['config', '--file', path.join(pushDir, 'config'), '--name-only', '--list'], { cwd: pushDir }))) {
        return { ok: false, error: 'push repository config tampered' };
      }

      // Command-line protocol overrides beat any config, so an insteadOf
      // rewrite cannot route the credentials through ext::, ssh, git or file
      // (file stays allowed only when the remote itself is a local path)
      const lockdown = PUSH_BLOCKED_PROTOCOLS
        .filter(protocol => !(protocol === 'file' && path.isAbsolute(remoteUrl)))
        .flatMap(protocol => ['-c', `protocol.${protocol}.allow=never`]);
      const push = await run([...lockdown, 'push', '-q', remoteUrl, `${sha}:refs/heads/${headRef}`], {
        cwd: pushDir, env: this.authEnv(ctx.token)
      });
      if (push.code !== 0) {
        const stderr = String(push.stderr).trim();
        // Only a lost race is rescheduled; any other rejection (a declined
        // hook, a protected branch) is a real failure that uses an attempt
        if (/non-fast-forward|fetch first/.test(stderr)) {
          // Someone else pushed: not this comment's fault, so retry next run
          return { ok: false, reschedule: true, error: 'PR branch changed before push' };
        }
        return { ok: false, error: `git push failed: ${stderr}` };
      }
      return { ok: true };
    } finally {
      fs.rmSync(pushDir, { recursive: true, force: true });
      this.activeDirs.delete(pushDir);
    }
  }

  // Rebuilds the new commits with attribution lines removed, keeping trees,
  // authors, and author dates. Returns the (possibly unchanged) head SHA.
  async stripCommitAttribution(workspace, base, commits) {
    const { git } = workspace;
    const messages = [];
    for (const sha of commits) {
      messages.push(await git(['log', '-1', '--format=%B', sha]));
    }
    if (!messages.some(message => ATTRIBUTION_PATTERN.test(message))) {
      return commits[commits.length - 1];
    }

    let parent = base;
    for (let i = 0; i < commits.length; i++) {
      const sha = commits[i];
      const [name, email, date] = (await git(['log', '-1', '--format=%an%x00%ae%x00%aI', sha]))
        .replace(/\n$/, '').split('\0');
      const tree = (await git(['rev-parse', `${sha}^{tree}`])).trim();
      const messageFile = path.join(workspace.root, `message-${i}.txt`);
      fs.writeFileSync(messageFile, stripAttribution(messages[i]));
      parent = (await git(['commit-tree', tree, '-p', parent, '-F', messageFile], {
        env: { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_AUTHOR_DATE: date }
      })).trim();
    }
    await git(['reset', '-q', '--hard', parent]);
    logger.info('Stripped attribution from engine commits', { commits: commits.length, head: parent });
    return parent;
  }

  async runTestGate(ctx, repoCfg, dir) {
    const commands = detectTestCommand(dir, repoCfg);
    if (!commands) {
      return { ok: false, error: 'no test command detected; set testCommand for this repository' };
    }
    const timeoutMs = ctx.settings.testTimeoutMinutes * 60 * 1000;
    // Tests run code from the PR branch, so they never see the GitHub token
    const env = { ...scrubEnv(process.env), CI: 'true' };
    const steps = [
      commands.install && { command: commands.install, label: 'dependency install' },
      { command: commands.test, label: 'tests' }
    ].filter(Boolean);

    for (const { command, label } of steps) {
      const result = await this.runCommand(command, { cwd: dir, env, timeoutMs });
      if (result.timedOut) {
        return { ok: false, error: `${label} timed out after ${ctx.settings.testTimeoutMinutes} minutes (${command})` };
      }
      if (result.code !== 0) {
        logger.warn('Babysit test gate failed', { command, output: tailLines(result.output, OUTPUT_TAIL_LINES) });
        return { ok: false, error: `${label} failed (${command})` };
      }
    }
    return { ok: true };
  }

  // One reply per inline thread; review bodies and issue comments share one
  // summary comment. Outcomes are decided separately from delivering them:
  // every outcome and every reply body is written to the ledger (pushed fixes
  // as 'pushed') in one save before any reply is sent. A failed or interrupted
  // reply is then retried on later runs on its own, never by re-running the fix.
  // `fix` is the pushed fix, or null when nothing was pushed.
  async postReplies(ctx, repoCfg, pr, headSha, settled, failures, fix, counts) {
    const { owner, repo } = repoCfg;
    const { ledger } = ctx;
    const number = pr.number;
    const keyFor = (comment) => BabysitterLedger.commentKey(owner, repo, number, comment.id);
    const base = { owner, repo, pr: number, pushedSha: fix?.commitSha || null };
    const deliveries = [];
    const summaryEntries = [];
    // Bots asked to re-review the pushed head; each is asked once per head
    const asked = new Set();

    for (const { comment, decision } of settled) {
      const key = keyFor(comment);
      const state = ACTION_STATES[decision.action];
      ledger.recordOutcome(key, {
        state: decision.action === 'fix' ? PUSHED_STATE : state,
        pr: number,
        headSha,
        action: decision.action,
        reasoning: decision.reasoning,
        commitSha: decision.action === 'fix' ? fix.commitSha : null
      }, { save: false });
      if (comment.kind !== 'review_comment') {
        summaryEntries.push({ comment, decision, key, state });
        continue;
      }
      const mention = mentionFor(comment.user);
      const reReview = decision.action === 'fix' && !(mention && asked.has(mention));
      if (reReview && mention) asked.add(mention);
      deliveries.push({
        ...base,
        id: `${key}#reply`,
        kind: 'inline',
        replyToId: comment.replyToId,
        body: inlineReplyBody(comment, decision, fix, { reReview }),
        keys: [key],
        states: { [key]: state }
      });
    }

    for (const { comment, action, error } of failures) {
      const key = keyFor(comment);
      const entry = ledger.recordFailure(key, { pr: number, headSha, action, error }, { save: false });
      counts.failed++;
      if (!entry.exhausted) continue;
      // Giving up: tell the reviewer once instead of going silent
      if (comment.kind === 'review_comment') {
        deliveries.push({
          ...base,
          id: `${key}#reply`,
          kind: 'inline',
          replyToId: comment.replyToId,
          body: giveUpReplyBody(comment, error),
          keys: [key],
          states: { [key]: 'failed' }
        });
      } else {
        summaryEntries.push({ comment, failed: true, error, key, state: 'failed' });
      }
    }

    if (summaryEntries.length) {
      deliveries.push({
        ...base,
        id: `${summaryEntries[0].key}#summary`,
        kind: 'summary',
        body: summaryCommentBody(summaryEntries, fix, asked),
        keys: summaryEntries.map(e => e.key),
        states: Object.fromEntries(summaryEntries.map(e => [e.key, e.state]))
      });
    }

    // The push intent goes in the same save that records the pushed outcomes
    ledger.clearPushIntent(BabysitterLedger.prKey(owner, repo, number), { save: false });
    ledger.addDeliveries(deliveries);
    for (const delivery of deliveries) await this.deliver(ctx, delivery, counts);
  }

  // Posts one reply and settles the comments it covers. On failure the
  // comments keep a pending reply that later runs retry.
  async deliver(ctx, delivery, counts) {
    const { client, ledger } = ctx;
    const { owner, repo, pr: number } = delivery;
    const reply = delivery.kind === 'inline'
      ? await client.replyToReviewComment(owner, repo, number, delivery.replyToId, delivery.body)
      : await client.createIssueComment(owner, repo, number, delivery.body);
    if (reply.success) {
      ledger.completeDelivery(delivery.id, reply.data.id);
      for (const key of delivery.keys) {
        const state = delivery.states?.[key];
        if (state && state !== 'failed') counts[state]++;
      }
      return true;
    }
    const failed = ledger.failDelivery(delivery.id, reply.error);
    counts.failed++;
    logger.warn('Babysit reply failed', {
      owner, repo, number, delivery: delivery.id, error: reply.error, attempts: failed?.attempts, abandoned: failed?.exhausted
    });
    return false;
  }

  // The current head of a PR: { head }, { gone } on a 404, or { error } for
  // any other (transient) lookup failure
  async lookupHead(client, owner, repo, number) {
    let current;
    try {
      current = await client.getPullRequest(owner, repo, number);
    } catch (error) {
      current = { success: false, error: error.message };
    }
    if (current?.success) return { head: current.data?.head?.sha || null };
    if (current?.status === 404) return { gone: true };
    return { error: `Get pull request #${number}: ${current?.error || 'unknown error'}` };
  }

  // A push intent left by a run that died around its push. If the branch head
  // is the expected SHA, the push landed: its stored outcomes are recorded and
  // their replies delivered, without running the engine again. Otherwise the
  // push never happened and the comments stay pending (or, for a push that
  // errored, get the failed outcomes it held back). A failed lookup keeps
  // the intent (and keeps the PR from being processed) until the next run.
  async reconcilePushIntents(ctx, selected, prFilter, results) {
    const { client, ledger } = ctx;
    const wanted = new Set(selected.map(r => `${r.owner}/${r.repo}`.toLowerCase()));
    for (const intent of ledger.getPushIntents()) {
      if (this.interrupted) return;
      const { prKey, owner, repo, pr: number } = intent;
      if (!wanted.has(`${owner}/${repo}`.toLowerCase())) continue;
      if (prFilter !== null && number !== prFilter) continue;

      const counts = emptyCounts();
      const result = { owner, repo, number, delivery: true, counts };
      const current = await this.lookupHead(client, owner, repo, number);
      if (current.error) {
        logger.warn('Could not reconcile an earlier push; retrying next run', { owner, repo, number, error: current.error });
        results.push({ ...result, success: false, error: current.error });
        continue;
      }
      if (current.head !== intent.expectedSha && intent.notLanded) {
        // The push errored and did not land after all: apply the failed
        // outcomes (charging the attempts) the run that pushed held back
        logger.warn('An earlier errored push did not land; charging its comments', {
          owner, repo, number, expected: intent.expectedSha, head: current.head, error: intent.notLanded.error
        });
        try {
          await this.postReplies(ctx, { owner, repo }, { number }, intent.sourceHead, intent.notLanded.settled, intent.notLanded.failures, null, counts);
          results.push({ ...result, reason: 'earlier push did not land', success: counts.failed === 0 });
        } catch (error) {
          logger.error('Failed to reconcile an earlier push', { owner, repo, number, error: error.message });
          results.push({ ...result, success: false, error: error.message });
        }
        continue;
      }
      if (current.head !== intent.expectedSha) {
        logger.warn('An earlier push did not land; its comments stay pending', {
          owner, repo, number, expected: intent.expectedSha, head: current.head
        });
        ledger.clearPushIntent(prKey);
        results.push({ ...result, success: true, reason: 'earlier push did not land; comments stay pending' });
        continue;
      }

      logger.info('Reconciling a push from an earlier run', { owner, repo, number, commit: intent.expectedSha });
      try {
        await this.postReplies(ctx, { owner, repo }, { number }, intent.sourceHead, intent.settled, intent.failures, intent.fix, counts);
        results.push({ ...result, reconciled: true, commitSha: intent.expectedSha, success: counts.failed === 0 });
      } catch (error) {
        logger.error('Failed to reconcile an earlier push', { owner, repo, number, error: error.message });
        results.push({ ...result, success: false, error: error.message });
      }
    }
  }

  // Delivery-only pass for replies left pending by earlier runs: a failed post,
  // or a crash between the push and the replies. The engine never runs here.
  async retryDeliveries(ctx, selected, prFilter, results) {
    const { client, ledger } = ctx;
    const wanted = new Set(selected.map(r => `${r.owner}/${r.repo}`.toLowerCase()));
    for (const delivery of ledger.getDeliveries()) {
      if (this.interrupted) return;
      const { owner, repo, pr: number } = delivery;
      if (!wanted.has(`${owner}/${repo}`.toLowerCase())) continue;
      if (prFilter !== null && number !== prFilter) continue;

      const counts = emptyCounts();
      const result = { owner, repo, number, delivery: true, counts };
      // Replies for a push that was never acknowledged only go out while the
      // branch still points at the pushed commit
      const unacknowledged = delivery.keys.some(key => ledger.getComment(key)?.state === PUSHED_STATE);
      if (unacknowledged) {
        const current = await this.lookupHead(client, owner, repo, number);
        if (current.error) {
          // No reply was attempted: the delivery stays pending and uncharged
          logger.warn('Could not check the PR head for a pending reply; retrying next run', {
            owner, repo, number, delivery: delivery.id, error: current.error
          });
          results.push({ ...result, success: false, error: current.error });
          continue;
        }
        if (current.gone || current.head !== delivery.pushedSha) {
          const note = current.gone
            ? 'pull request not found; reply not delivered'
            : `branch moved after push (now ${current.head || 'unknown'}); reply not delivered`;
          logger.warn('Settling an unacknowledged push without a reply', {
            owner, repo, number, pushed: delivery.pushedSha, head: current.head, gone: Boolean(current.gone)
          });
          ledger.completeDelivery(delivery.id, null, { note });
          result.reason = current.gone ? 'pull request not found; reply not delivered' : 'branch moved after push; reply not delivered';
          results.push({ ...result, success: true });
          continue;
        }
      }
      try {
        await this.deliver(ctx, delivery, counts);
      } catch (error) {
        ledger.failDelivery(delivery.id, error.message);
        counts.failed++;
        logger.warn('Babysit reply retry failed', { owner, repo, number, delivery: delivery.id, error: error.message });
      }
      results.push({ ...result, success: counts.failed === 0 });
    }
  }
}

export default new Babysitter();
