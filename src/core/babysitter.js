import fs from 'fs';
import os from 'os';
import path from 'path';
import GitHubClient from '../github/client.js';
import config from '../config/loader.js';
import logger from '../utils/logger.js';
import { acquireRunLock } from '../utils/run-lock.js';
import { runGit, gitAuthEnv, scrubEnv } from '../utils/git.js';
import { detectTestCommand, runTestCommand, tailLines } from '../utils/test-detector.js';
import { BabysitterLedger, MAX_ATTEMPTS } from '../utils/babysitter-ledger.js';
import { createReviewEngine } from '../utils/review-engine.js';
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

function emptyCounts() {
  return { addressed: 0, deferred: 0, wontfix: 0, noted: 0, failed: 0 };
}

function unwrap(result, what) {
  if (!result?.success) {
    throw new Error(`${what}: ${result?.error || 'unknown error'}`);
  }
  return result.data;
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
    if (result.number !== undefined) summary.prs++;
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

export function inlineReplyBody(comment, decision, fix) {
  const mention = mentionFor(comment.user);
  const lead = mention ? `${mention} ` : '';
  let text;
  switch (decision.action) {
    case 'fix':
      text = `${fixDetail(comment, decision, fix)}\n\n${mention ? `${mention} please re-review.` : 'Please re-review.'}`;
      break;
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
// inline threads) cannot be replied to individually
export function summaryCommentBody(entries, fix) {
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
  if (bots.size) {
    parts.push('', `${[...bots].join(' ')} please re-review the latest changes.`);
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
  // runCommand, remoteUrl(owner, repo), tmpDir, acquireLock
  constructor(options = {}) {
    this.options = options;
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

    try {
      return await this.run(cfg, opts);
    } finally {
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

      logger.info('Starting babysit scan', {
        repositories: selected.length, label: settings.label, engine: settings.engine, dryRun
      });

      let budget = settings.maxPrsPerRun;
      for (const repoCfg of selected) {
        if (budget <= 0) break;
        const { owner, repo } = repoCfg;

        let candidates;
        try {
          const issues = unwrap(
            await client.listLabeledPullRequests(owner, repo, settings.label),
            `List ${settings.label} pull requests for ${owner}/${repo}`
          );
          candidates = issues
            .filter(issue => pr === null || issue.number === pr)
            .filter(issue => !settings.ownPRsOnly || sameLogin(issue.user?.login, me.login))
            .sort((a, b) => a.number - b.number);
        } catch (error) {
          results.push({ owner, repo, success: false, error: error.message, counts: emptyCounts() });
          continue;
        }

        for (const issue of candidates) {
          if (budget <= 0) break;
          budget--;
          let result;
          try {
            result = await this.processPullRequest(ctx, repoCfg, issue.number);
          } catch (error) {
            logger.error('Babysit failed for pull request', { owner, repo, number: issue.number, error: error.message });
            result = { success: false, error: error.message, counts: emptyCounts() };
          }
          results.push({ owner, repo, number: issue.number, ...result });
        }
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
    const workspace = await this.prepareWorkspace(ctx, repoCfg, pr);
    try {
      if (workspace.headMoved) {
        return { success: true, skipped: true, reason: 'PR head moved during the scan; retrying next run', counts };
      }
      return await this.handleComments(ctx, repoCfg, pr, pending, workspace, counts);
    } finally {
      workspace.cleanup();
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
    const cleanup = () => fs.rmSync(root, { recursive: true, force: true });

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
    // Triage is read-only; discard anything the engine changed anyway
    await workspace.resetToHead();

    const plan = [];
    const failures = [];
    if (!triage.ok) {
      for (const comment of pending) failures.push({ comment, action: null, error: `triage failed: ${triage.error}` });
    } else {
      const byId = new Map(triage.decisions.map(d => [d.id, d]));
      for (const comment of pending) {
        const decision = byId.get(comment.id);
        if (decision) plan.push({ comment, decision });
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
    let fix = null;
    if (fixItems.length) {
      try {
        fix = await this.applyFixes(ctx, repoCfg, pr, prInfo, workspace, fixItems);
      } catch (error) {
        fix = { ok: false, error: error.message };
      }
      if (!fix.ok) {
        logger.warn('Babysit fix was not pushed', { owner, repo, number: pr.number, error: fix.error });
        for (const { comment } of fixItems) failures.push({ comment, action: 'fix', error: fix.error });
      } else {
        logger.info('Babysit fix pushed', { owner, repo, number: pr.number, commit: fix.commitSha });
      }
    }

    const settled = plan.filter(p => p.decision.action !== 'fix' || fix?.ok);
    await this.postReplies(ctx, repoCfg, pr, workspace.headSha, settled, failures, fix, counts);

    return {
      success: counts.failed === 0,
      counts,
      commitSha: fix?.ok ? fix.commitSha : null,
      failures: failures.map(f => ({ id: f.comment.id, error: f.error }))
    };
  }

  async applyFixes(ctx, repoCfg, pr, prInfo, workspace, fixItems) {
    const { git, run, dir, headSha } = workspace;

    const implement = await ctx.engine.implement({
      cwd: dir,
      pr: prInfo,
      items: fixItems,
      reportFile: path.join(workspace.scratch, 'implement.json'),
      env: scrubEnv(process.env)
    });
    if (!implement.ok) return { ok: false, error: `engine failed: ${implement.error}` };

    // Engines without shell access (claude in acceptEdits mode) can edit files
    // but not commit, so leftovers are committed here
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
    const pushed = await this.pushPinned(ctx, workspace, finalHead, pr.head.ref);
    if (!pushed.ok) return pushed;

    return { ok: true, commitSha: finalHead, report: implement.report, changedFiles };
  }

  // Same pattern as fix-conflicts: the authenticated push runs from a fresh
  // bare repository whose config the PR code never saw, sends the pinned SHA
  // (not HEAD), and is never forced, so it only fast-forwards. mkdtemp makes
  // its path unpredictable, so PR code cannot plant a repository there.
  async pushPinned(ctx, workspace, sha, headRef) {
    const { run, git, remoteUrl } = workspace;
    const pushDir = fs.mkdtempSync(path.join(workspace.workRoot, 'sdg-babysit-push-'));
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
        if (/rejected|non-fast-forward|fetch first/.test(stderr)) {
          return { ok: false, error: 'PR branch changed before push' };
        }
        return { ok: false, error: `git push failed: ${stderr}` };
      }
      return { ok: true };
    } finally {
      fs.rmSync(pushDir, { recursive: true, force: true });
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
  // summary comment. Each ledger entry is written right after its reply so a
  // crash cannot cause a second reply on the next run.
  async postReplies(ctx, repoCfg, pr, headSha, settled, failures, fix, counts) {
    const { owner, repo } = repoCfg;
    const { client, ledger } = ctx;
    const number = pr.number;
    const keyFor = (comment) => BabysitterLedger.commentKey(owner, repo, number, comment.id);
    const summaryEntries = [];

    const recordReplyFailure = (comment, decision, record, error) => {
      counts.failed++;
      if (decision.action === 'fix') {
        // The fix is already pushed; settle it so it is not applied twice
        ledger.recordOutcome(keyFor(comment), { ...record, replyId: null });
        counts.addressed++;
      } else {
        ledger.recordFailure(keyFor(comment), { pr: number, headSha, action: decision.action, error: `reply failed: ${error}` });
      }
    };

    for (const { comment, decision } of settled) {
      const record = {
        state: ACTION_STATES[decision.action],
        pr: number,
        headSha,
        action: decision.action,
        reasoning: decision.reasoning,
        commitSha: decision.action === 'fix' ? fix.commitSha : null
      };
      if (comment.kind !== 'review_comment') {
        summaryEntries.push({ comment, decision, record });
        continue;
      }
      const reply = await client.replyToReviewComment(owner, repo, number, comment.replyToId,
        inlineReplyBody(comment, decision, fix));
      if (reply.success) {
        ledger.recordOutcome(keyFor(comment), { ...record, replyId: reply.data.id });
        counts[record.state]++;
      } else {
        recordReplyFailure(comment, decision, record, reply.error);
      }
    }

    for (const { comment, action, error } of failures) {
      const entry = ledger.recordFailure(keyFor(comment), { pr: number, headSha, action, error });
      counts.failed++;
      if (!entry.exhausted) continue;
      // Giving up: tell the reviewer once instead of going silent
      if (comment.kind === 'review_comment') {
        const reply = await client.replyToReviewComment(owner, repo, number, comment.replyToId,
          giveUpReplyBody(comment, error));
        if (reply.success) ledger.setReplyId(keyFor(comment), reply.data.id);
      } else {
        summaryEntries.push({ comment, failed: true, error });
      }
    }

    if (summaryEntries.length === 0) return;

    const reply = await client.createIssueComment(owner, repo, number, summaryCommentBody(summaryEntries, fix));
    for (const entry of summaryEntries) {
      if (entry.failed) {
        if (reply.success) ledger.setReplyId(keyFor(entry.comment), reply.data.id);
      } else if (reply.success) {
        ledger.recordOutcome(keyFor(entry.comment), { ...entry.record, replyId: reply.data.id });
        counts[entry.record.state]++;
      } else {
        recordReplyFailure(entry.comment, entry.decision, entry.record, reply.error);
      }
    }
  }
}

export default new Babysitter();
