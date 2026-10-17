import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-fixer-lock-'));
process.env.SDG_RUN_LOCK_FILE = path.join(lockDir, 'run.lock');
process.env.SDG_CONFLICT_FIXER_STATE_FILE = path.join(lockDir, 'conflict-fixer-state.json');

const {
  default: ConflictFixer, isConflicted, selectRepositories, summarize, parseScanTimeout, gateReason
} = await import('../src/core/conflict-fixer.js');
const { FixerLedger, ledgerKey } = await import('../src/utils/fixer-ledger.js');
const { default: GitHubClient } = await import('../src/github/client.js');
const { getRunExitCode } = await import('../src/core/executor.js');
const { runGit } = await import('../src/utils/git.js');
const { acquireRunLock } = await import('../src/utils/run-lock.js');

const IDENTITY = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com'];
const PASSING_PACKAGE = JSON.stringify({ name: 'demo', scripts: { test: 'node -e "process.exit(0)"' } });

async function git(cwd, args, date) {
  const env = date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {};
  const result = await runGit([...IDENTITY, ...args], { cwd, env });
  if (result.code !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function numbered(overrides = {}) {
  return Array.from({ length: 12 }, (_, i) => `${overrides[i + 1] ?? `line ${i + 1}`}\n`).join('');
}

async function commit(cwd, files, date) {
  for (const [file, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(cwd, file), content);
    await git(cwd, ['add', file]);
  }
  await git(cwd, ['commit', '-q', '-m', 'change'], date);
}

// A bare "remote" with master and a feature branch that conflicts with it
// (unless conflicting is false); master's line 2 change is the newer one
async function fixture(t, { withPackage = true, conflicting = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-fixer-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const work = path.join(root, 'work');
  const remote = path.join(root, 'remote.git');
  const workRoot = path.join(root, 'tmp');
  fs.mkdirSync(work);
  fs.mkdirSync(workRoot);

  await git(root, ['init', '-q', '--bare', '-b', 'master', remote]);
  await git(work, ['init', '-q', '-b', 'master']);
  await commit(work, withPackage ? { 'app.txt': numbered(), 'package.json': PASSING_PACKAGE } : { 'app.txt': numbered() }, '2025-12-01T00:00:00Z');
  await git(work, ['branch', 'feature']);
  await commit(work, { 'app.txt': numbered({ 2: 'master 2' }) }, '2026-02-01T00:00:00Z');
  await git(work, ['checkout', '-q', 'feature']);
  await commit(work, { 'app.txt': numbered(conflicting ? { 2: 'feature 2' } : { 9: 'feature 9' }) }, '2026-01-01T00:00:00Z');
  await git(work, ['push', '-q', remote, 'master', 'feature']);

  const pr = {
    number: 7,
    headRefName: 'feature',
    headRefOid: await git(work, ['rev-parse', 'feature']),
    baseRefName: 'master',
    isCrossRepository: false,
    mergeable: 'CONFLICTING',
    mergeStateStatus: 'DIRTY'
  };
  const remoteHead = () => git(remote, ['rev-parse', 'refs/heads/feature']);
  const ledgerFile = path.join(root, 'conflict-fixer-state.json');
  return { root, work, remote, workRoot, pr, remoteHead, ledgerFile };
}

function stubClient(pulls) {
  const calls = { list: 0 };
  return {
    calls,
    validate: async () => ({ success: true, user: 'bot', id: 42 }),
    listOpenPullRequests: async () => {
      calls.list++;
      return { success: true, data: typeof pulls === 'function' ? pulls() : pulls };
    }
  };
}

function makeFixer(fx, pulls, options = {}) {
  const client = stubClient(pulls);
  const fixer = new ConflictFixer('ghp_test', {
    client,
    remoteUrl: () => fx.remote,
    workRoot: fx.workRoot,
    retryDelayMs: 0,
    ledger: new FixerLedger({ filePath: fx.ledgerFile }),
    ...options
  });
  return { fixer, client };
}

function config(repoOverrides = {}) {
  return {
    general: { dryRun: false },
    repositories: [{ owner: 'me', repo: 'demo', enabled: true, testCommand: null, ...repoOverrides }],
    conflictFixer: { testTimeoutMinutes: 1, installDeps: true, mode: 'all' }
  };
}

test('isConflicted matches CONFLICTING or DIRTY pull requests', () => {
  assert.equal(isConflicted({ mergeable: 'CONFLICTING', mergeStateStatus: 'BLOCKED' }), true);
  assert.equal(isConflicted({ mergeable: 'UNKNOWN', mergeStateStatus: 'DIRTY' }), true);
  assert.equal(isConflicted({ mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }), false);
});

test('selectRepositories filters enabled repositories and rejects unknown filters', () => {
  const repos = [{ owner: 'me', repo: 'a' }, { owner: 'me', repo: 'b', enabled: false }];
  assert.deepEqual(selectRepositories(repos), [repos[0]]);
  assert.deepEqual(selectRepositories(repos, ['Me/A']), [repos[0]]);
  assert.throws(() => selectRepositories(repos, ['me/b']), /not configured or disabled/);
});

test('summarize counts fixed, manual review, skipped, and failed results', () => {
  const summary = summarize([
    { status: 'fixed', success: true, skipped: false },
    { status: 'would-fix', success: true, skipped: false },
    { status: 'needs-manual-review', success: true, skipped: true },
    { status: 'skipped', success: true, skipped: true },
    { status: 'error', success: false, skipped: true },
    { status: 'scan-timeout', success: true, skipped: true }
  ]);
  assert.deepEqual(summary, { total: 6, fixed: 2, needsManualReview: 1, skipped: 2, scanTimeout: 1, failed: 1 });
});

test('fixes a conflicted PR, pushes a merge commit, and cleans up', async (t) => {
  const fx = await fixture(t);
  const { fixer } = makeFixer(fx, [fx.pr]);

  const result = await fixer.run(config());

  assert.equal(result.success, true, result.error);
  assert.equal(result.results[0].status, 'fixed', result.results[0].reason);
  assert.deepEqual(result.summary, { total: 1, fixed: 1, needsManualReview: 0, skipped: 0, scanTimeout: 0, failed: 0 });

  const parents = (await git(fx.remote, ['rev-list', '--parents', '-n', '1', 'refs/heads/feature'])).split(' ');
  assert.equal(parents.length, 3);
  assert.equal(parents[1], fx.pr.headRefOid);
  // master's line 2 change is newer, so it wins the hunk
  assert.equal(await git(fx.remote, ['show', 'refs/heads/feature:app.txt']), numbered({ 2: 'master 2' }).trim());
  const message = await git(fx.remote, ['log', '-1', '--format=%an <%ae>%n%B', 'refs/heads/feature']);
  assert.match(message, /^bot <42\+bot@users\.noreply\.github\.com>\nMerge branch 'master' into feature/);
  assert.deepEqual(fs.readdirSync(fx.workRoot), []);
});

test('does not push when tests fail', async (t) => {
  const fx = await fixture(t);
  const { fixer } = makeFixer(fx, [fx.pr]);

  const result = await fixer.run(config({ testCommand: 'echo broken; exit 1' }));

  assert.equal(result.results[0].status, 'needs-manual-review');
  assert.match(result.results[0].reason, /tests failed/);
  assert.match(result.results[0].output, /broken/);
  assert.equal(await fx.remoteHead(), fx.pr.headRefOid);
  assert.deepEqual(fs.readdirSync(fx.workRoot), []);
});

test('does not push when no test command is detected', async (t) => {
  const fx = await fixture(t, { withPackage: false });
  const { fixer } = makeFixer(fx, [fx.pr]);

  const result = await fixer.run(config());

  assert.equal(result.results[0].status, 'needs-manual-review');
  assert.match(result.results[0].reason, /no test command/);
  assert.equal(await fx.remoteHead(), fx.pr.headRefOid);
});

test('dry run resolves and tests without pushing', async (t) => {
  const fx = await fixture(t);
  const { fixer } = makeFixer(fx, [fx.pr]);

  const result = await fixer.run(config(), { dryRun: true });

  assert.equal(result.results[0].status, 'would-fix', result.results[0].reason);
  assert.equal(await fx.remoteHead(), fx.pr.headRefOid);
});

test('test commands never see the GitHub token', async (t) => {
  const fx = await fixture(t);
  let seenEnv;
  const { fixer } = makeFixer(fx, [fx.pr], {
    runCommand: async (command, { env }) => {
      seenEnv = env;
      return { code: 0, timedOut: false, output: '' };
    }
  });
  process.env.GITHUB_TOKEN = 'ghp_secret';
  t.after(() => delete process.env.GITHUB_TOKEN);

  await fixer.run(config(), { dryRun: true });

  assert.equal(seenEnv.GITHUB_TOKEN, undefined);
  assert.equal(Object.keys(seenEnv).some(key => key.startsWith('GIT_CONFIG_')), false);
});

test('reports stale-status when the PR merges cleanly locally', async (t) => {
  const fx = await fixture(t, { conflicting: false });
  const { fixer } = makeFixer(fx, [fx.pr]);

  const result = await fixer.run(config());

  assert.equal(result.results[0].status, 'stale-status');
  assert.equal(await fx.remoteHead(), fx.pr.headRefOid);
});

test('reports head-moved when the branch differs from the reported head', async (t) => {
  const fx = await fixture(t);
  const stalePr = { ...fx.pr, headRefOid: await git(fx.work, ['rev-parse', 'master~1']) };
  const { fixer } = makeFixer(fx, [stalePr]);

  const result = await fixer.run(config());

  assert.equal(result.results[0].status, 'head-moved');
  assert.equal(await fx.remoteHead(), fx.pr.headRefOid);
});

test('never force-pushes over commits added while tests ran', async (t) => {
  const fx = await fixture(t);
  let newHead;
  const { fixer } = makeFixer(fx, [fx.pr], {
    runCommand: async () => {
      await commit(fx.work, { 'other.txt': 'new\n' }, '2026-04-01T00:00:00Z');
      await git(fx.work, ['push', '-q', fx.remote, 'feature']);
      newHead = await git(fx.work, ['rev-parse', 'feature']);
      return { code: 0, timedOut: false, output: '' };
    }
  });

  const result = await fixer.run(config());

  assert.equal(result.results[0].status, 'head-moved');
  assert.equal(await fx.remoteHead(), newHead);
});

test('skips fork PRs and reports PRs whose mergeability stays unknown', async (t) => {
  const fx = await fixture(t);
  const pulls = [
    { ...fx.pr, number: 1, isCrossRepository: true },
    { ...fx.pr, number: 2, mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' },
    { ...fx.pr, number: 3, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }
  ];
  const { fixer, client } = makeFixer(fx, pulls);

  const result = await fixer.run(config());

  assert.deepEqual(result.results.map(r => [r.pr, r.status]), [[1, 'skipped'], [2, 'unknown']]);
  assert.equal(client.calls.list, 4);
  assert.equal(await fx.remoteHead(), fx.pr.headRefOid);
});

test('scan-only lists conflicted PRs without cloning', async (t) => {
  const fx = await fixture(t);
  const { fixer } = makeFixer(fx, [fx.pr], { git: async () => assert.fail('git must not run') });

  const result = await fixer.run(config(), { scanOnly: true });

  assert.deepEqual(result.results.map(r => [r.pr, r.status, r.reason]), [[7, 'conflicted', 'feature -> master']]);
});

test('--pr filters to one pull request and requires a single repository', async (t) => {
  const fx = await fixture(t);
  const { fixer } = makeFixer(fx, [fx.pr, { ...fx.pr, number: 8 }]);

  const filtered = await fixer.run(config(), { scanOnly: true, repos: ['me/demo'], pr: '8' });
  assert.deepEqual(filtered.results.map(r => r.pr), [8]);

  const unscoped = await fixer.run(config(), { scanOnly: true, pr: '8' });
  assert.equal(unscoped.success, false);
  assert.match(unscoped.error, /--pr requires exactly one --repo/);
});

test('reports a listing failure as a failed repository', async (t) => {
  const fx = await fixture(t);
  const { fixer } = makeFixer(fx, []);
  fixer.client.listOpenPullRequests = async () => ({ success: false, error: 'Not Found' });

  const result = await fixer.run(config());

  assert.equal(result.summary.failed, 1);
  assert.equal(result.results[0].error, 'Not Found');
});

test('refuses to run while another execution holds the lock', async (t) => {
  const fx = await fixture(t);
  const { fixer } = makeFixer(fx, [fx.pr]);
  const lock = acquireRunLock();
  t.after(() => lock.release());

  const result = await fixer.run(config());

  assert.equal(result.success, false);
  assert.equal(result.locked, true);
});

// --- Attempt ledger ---

const MINUTE = 60 * 1000;
const KEY = ledgerKey('me', 'demo', 7);

function seedLedger(fx, entry) {
  fs.writeFileSync(fx.ledgerFile, JSON.stringify({ [KEY]: entry }));
}

test('records a finished attempt in the ledger', async (t) => {
  const fx = await fixture(t);
  let clock = 5 * MINUTE;
  const { fixer } = makeFixer(fx, [fx.pr], { now: () => clock });

  await fixer.run(config());

  assert.deepEqual(JSON.parse(fs.readFileSync(fx.ledgerFile, 'utf8')), {
    [KEY]: { headSha: fx.pr.headRefOid, status: 'fixed', startedAt: clock, finishedAt: clock }
  });
});

test('skips a PR whose same head SHA is already in progress', async (t) => {
  const fx = await fixture(t);
  const now = 100 * MINUTE;
  seedLedger(fx, { headSha: fx.pr.headRefOid, status: 'in-progress', startedAt: now - 59 * MINUTE, finishedAt: null });
  const { fixer } = makeFixer(fx, [fx.pr], { now: () => now, git: async () => assert.fail('git must not run') });

  const result = await fixer.run(config());

  assert.deepEqual(result.results.map(r => [r.status, r.reason]), [['skipped', 'already-in-progress']]);
  assert.equal(await fx.remoteHead(), fx.pr.headRefOid);
});

test('retries an in-progress attempt once the attempt TTL has expired', async (t) => {
  const fx = await fixture(t);
  const now = 100 * MINUTE;
  seedLedger(fx, { headSha: fx.pr.headRefOid, status: 'in-progress', startedAt: now - 61 * MINUTE, finishedAt: null });
  const { fixer } = makeFixer(fx, [fx.pr], { now: () => now });

  const result = await fixer.run(config());

  assert.equal(result.results[0].status, 'fixed', result.results[0].reason);
  assert.equal(JSON.parse(fs.readFileSync(fx.ledgerFile, 'utf8'))[KEY].startedAt, now);
});

test('skips a finished attempt on the same head SHA within the retry cooldown', async (t) => {
  const fx = await fixture(t);
  const now = 1000 * MINUTE;
  seedLedger(fx, { headSha: fx.pr.headRefOid, status: 'needs-manual-review', startedAt: 0, finishedAt: now - 239 * MINUTE });
  const { fixer } = makeFixer(fx, [fx.pr], { now: () => now, git: async () => assert.fail('git must not run') });

  const result = await fixer.run(config());

  assert.deepEqual(result.results.map(r => [r.status, r.reason]), [['skipped', 'already-attempted']]);
});

test('honours configured TTL and cooldown windows', async (t) => {
  const fx = await fixture(t);
  const now = 1000 * MINUTE;
  seedLedger(fx, { headSha: fx.pr.headRefOid, status: 'failed', startedAt: 0, finishedAt: now - 11 * MINUTE });
  const { fixer } = makeFixer(fx, [fx.pr], { now: () => now });
  const cfg = config();
  cfg.conflictFixer.retryCooldownMinutes = 10;

  const result = await fixer.run(cfg);

  assert.equal(result.results[0].status, 'fixed', result.results[0].reason);
});

test('re-attempts a PR whose head SHA changed and overwrites the entry', async (t) => {
  const fx = await fixture(t);
  const now = 1000 * MINUTE;
  seedLedger(fx, { headSha: 'f'.repeat(40), status: 'fixed', startedAt: now - MINUTE, finishedAt: now - MINUTE });
  const { fixer } = makeFixer(fx, [fx.pr], { now: () => now });

  const result = await fixer.run(config());

  assert.equal(result.results[0].status, 'fixed', result.results[0].reason);
  assert.deepEqual(JSON.parse(fs.readFileSync(fx.ledgerFile, 'utf8'))[KEY], {
    headSha: fx.pr.headRefOid, status: 'fixed', startedAt: now, finishedAt: now
  });
});

test('scan-only and dry runs never write the ledger', async (t) => {
  const fx = await fixture(t);
  const { fixer } = makeFixer(fx, [fx.pr]);

  await fixer.run(config(), { scanOnly: true });
  assert.equal(fs.existsSync(fx.ledgerFile), false);

  const dry = await fixer.run(config(), { dryRun: true });
  assert.equal(dry.results[0].status, 'would-fix');
  assert.equal(fs.existsSync(fx.ledgerFile), false);
});

// --- Signal safety ---

test('interrupt marks in-progress attempts as interrupted and exits non-zero', async (t) => {
  const fx = await fixture(t);
  const exits = [];
  const { fixer } = makeFixer(fx, [], { now: () => 2000, exit: (code) => exits.push(code) });
  fixer.ledger.start(KEY, fx.pr.headRefOid, 1000);
  fixer.activeKeys.add(KEY);
  fixer.activeDir = fs.mkdtempSync(path.join(fx.workRoot, 'sdg-fix-'));

  fixer.interrupt('SIGTERM');
  fixer.interrupt('SIGINT');

  assert.deepEqual(exits, [143, 130]);
  assert.deepEqual(fixer.ledger.load()[KEY], { headSha: fx.pr.headRefOid, status: 'interrupted', startedAt: 1000, finishedAt: 2000 });
  assert.deepEqual(fs.readdirSync(fx.workRoot), []);
});

test('signal handlers are installed only for the duration of a run', async (t) => {
  const fx = await fixture(t);
  const before = process.listenerCount('SIGTERM');
  let during;
  let activeDuring;
  const { fixer } = makeFixer(fx, [fx.pr], {
    runCommand: async () => {
      during = process.listenerCount('SIGTERM');
      activeDuring = [...fixer.activeKeys];
      return { code: 0, timedOut: false, output: '' };
    }
  });

  await fixer.run(config());

  assert.equal(during, before + 1);
  assert.deepEqual(activeDuring, [KEY]);
  assert.equal(process.listenerCount('SIGTERM'), before);
  assert.equal(fixer.activeKeys.size, 0);
});

// --- Scan-time budget ---

function multiConfig(names, conflictFixer = {}) {
  return {
    general: { dryRun: false },
    repositories: names.map(repo => ({ owner: 'me', repo, enabled: true, testCommand: null })),
    conflictFixer: { testTimeoutMinutes: 1, installDeps: true, mode: 'all', ...conflictFixer }
  };
}

// Each listing takes `costMs` of fake time; repo "a" has the conflicted PR
function timedClient(fx, clock, costMs) {
  const listed = [];
  return {
    listed,
    validate: async () => ({ success: true, user: 'bot', id: 42 }),
    listOpenPullRequests: async (owner, repo) => {
      listed.push(repo);
      clock.now += costMs;
      return { success: true, data: repo === 'a' ? [fx.pr] : [] };
    }
  };
}

test('an exhausted scan budget still fixes collected PRs and reports the rest', async (t) => {
  const fx = await fixture(t);
  const clock = { now: 0 };
  const client = timedClient(fx, clock, 200 * 1000);
  const { fixer } = makeFixer(fx, [], { client, now: () => clock.now });

  const result = await fixer.run(multiConfig(['a', 'b', 'c']));

  assert.deepEqual(client.listed, ['a']);
  assert.deepEqual(result.results.map(r => [r.repo, r.status]), [['a', 'fixed'], ['b', 'scan-timeout'], ['c', 'scan-timeout']]);
  assert.equal(result.results[1].reason, 'scan budget exhausted');
  assert.equal(result.summary.scanTimeout, 2);
  assert.equal(result.summary.fixed, 1);
  assert.equal(getRunExitCode(result), 0);
});

test('a repository cut off mid-pagination is reported as scan-timeout', async (t) => {
  const fx = await fixture(t);
  const clock = { now: 0 };
  const client = new GitHubClient('ghp_test');
  client.validate = async () => ({ success: true, user: 'bot', id: 42 });
  client.octokit = {
    graphql: async (query, { repo }) => {
      clock.now += 50 * 1000;
      const nodes = repo === 'a' ? [fx.pr] : [{ ...fx.pr, number: 99 }];
      return { repository: { pullRequests: { nodes, pageInfo: { hasNextPage: repo === 'b', endCursor: 'next' } } } };
    }
  };
  const { fixer } = makeFixer(fx, [], { client, now: () => clock.now });

  const result = await fixer.run(multiConfig(['a', 'b'], { scanTimeoutSeconds: 90 }));

  assert.deepEqual(result.results.map(r => [r.repo, r.pr, r.status]), [['a', 7, 'fixed'], ['b', undefined, 'scan-timeout']]);
});

test('the scan-timeout option overrides the configured budget', async (t) => {
  const fx = await fixture(t);
  const run = async (options) => {
    const clock = { now: 0 };
    const { fixer } = makeFixer(fx, [], { client: timedClient(fx, clock, 10 * 1000), now: () => clock.now });
    const result = await fixer.run(multiConfig(['a', 'b'], { scanTimeoutSeconds: 1000 }), { scanOnly: true, ...options });
    return result.results.map(r => [r.repo, r.status]);
  };

  assert.deepEqual(await run({}), [['a', 'conflicted']]);
  assert.deepEqual(await run({ scanTimeoutSeconds: '5' }), [['a', 'conflicted'], ['b', 'scan-timeout']]);
});

test('UNKNOWN re-polls stop when the remaining budget cannot cover the sleep', async (t) => {
  const fx = await fixture(t);
  const clock = { now: 0 };
  const unknown = { ...fx.pr, mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' };
  const { fixer, client } = makeFixer(fx, [unknown], { now: () => clock.now, retryDelayMs: 2000 });
  fixer.delay = async (ms) => { clock.now += ms; };

  const result = await fixer.run(multiConfig(['demo'], { scanTimeoutSeconds: 3 }));

  assert.equal(client.calls.list, 2);
  assert.deepEqual(result.results.map(r => r.status), ['unknown']);
});

test('invalid scan-timeout values are rejected', async (t) => {
  for (const value of ['0', '-1', 'abc', '']) {
    assert.throws(() => parseScanTimeout(value), /--scan-timeout must be a positive number of seconds/);
  }
  assert.equal(parseScanTimeout('2.5'), 2.5);

  const fx = await fixture(t);
  const { fixer } = makeFixer(fx, [fx.pr]);
  const result = await fixer.run(config(), { scanTimeoutSeconds: 0 });
  assert.equal(result.success, false);
  assert.match(result.error, /--scan-timeout/);
});

// --- Repo gate ---

test('gateReason applies per-repo flag, denylist, then allowlist mode in order', () => {
  const repo = (overrides = {}) => ({ owner: 'me', repo: 'api', conflictFixer: null, ...overrides });
  const lists = { mode: 'allowlist', allowlist: ['me/api'], denylist: ['me/api'] };

  assert.equal(gateReason(repo({ conflictFixer: false }), { mode: 'all' }), 'disabled-per-repo');
  assert.equal(gateReason(repo({ conflictFixer: true }), lists), null);
  assert.equal(gateReason(repo(), lists), 'denylisted');
  assert.equal(gateReason(repo(), { mode: 'denylist', denylist: ['me/api'] }), 'denylisted');
  assert.equal(gateReason(repo(), { mode: 'allowlist', allowlist: ['me/other'] }), 'not-allowlisted');
  assert.equal(gateReason(repo(), { mode: 'allowlist', allowlist: ['me/api'] }), null);
  assert.equal(gateReason(repo(), { mode: 'denylist', denylist: ['me/other'] }), null);
  assert.equal(gateReason(repo(), { mode: 'all' }), null);
});

test('gateReason skips everything when the conflictFixer block is absent', () => {
  assert.equal(gateReason({ owner: 'me', repo: 'api' }), 'not-allowlisted');
  assert.equal(gateReason({ owner: 'me', repo: 'api' }, {}), 'not-allowlisted');
  assert.equal(gateReason({ owner: 'me', repo: 'api' }, { allowlist: [] }), 'not-allowlisted');
});

test('gateReason matches list entries case-insensitively', () => {
  assert.equal(gateReason({ owner: 'Me', repo: 'Api' }, { allowlist: ['me/API'] }), null);
  assert.equal(gateReason({ owner: 'me', repo: 'api' }, { mode: 'all', denylist: ['ME/Api'] }), 'denylisted');
});

test('gated repositories are reported as skipped and never listed or cloned', async (t) => {
  const fx = await fixture(t);
  const clock = { now: 0 };
  const client = timedClient(fx, clock, 0);
  const { fixer } = makeFixer(fx, [], { client, git: async () => assert.fail('git must not run') });
  const cfg = multiConfig(['a', 'b'], { mode: 'allowlist', allowlist: [] });

  const result = await fixer.run(cfg);

  assert.deepEqual(client.listed, []);
  assert.deepEqual(result.results.map(r => [r.repo, r.status, r.reason]), [
    ['a', 'skipped', 'not-allowlisted'],
    ['b', 'skipped', 'not-allowlisted']
  ]);
  assert.equal(getRunExitCode(result), 0);
  assert.equal(await fx.remoteHead(), fx.pr.headRefOid);
});

test('--repo cannot bypass the gate, including in scan-only mode', async (t) => {
  const fx = await fixture(t);
  const clock = { now: 0 };
  const client = timedClient(fx, clock, 0);
  const { fixer } = makeFixer(fx, [], { client });
  const cfg = multiConfig(['a', 'b'], { mode: 'denylist', denylist: ['me/a'] });

  for (const scanOnly of [false, true]) {
    const result = await fixer.run(cfg, { repos: ['me/a'], scanOnly });
    assert.deepEqual(result.results.map(r => [r.repo, r.status, r.reason]), [['a', 'skipped', 'denylisted']]);
  }
  assert.deepEqual(client.listed, []);
});

test('scan-only lists allowed repos alongside gated-out rows', async (t) => {
  const fx = await fixture(t);
  const clock = { now: 0 };
  const client = timedClient(fx, clock, 0);
  const { fixer } = makeFixer(fx, [], { client });
  const cfg = multiConfig(['a', 'b'], { mode: 'allowlist', allowlist: ['ME/A'] });

  const result = await fixer.run(cfg, { scanOnly: true });

  assert.deepEqual(result.results.map(r => [r.repo, r.status, r.reason]), [
    ['a', 'conflicted', 'feature -> master'],
    ['b', 'skipped', 'not-allowlisted']
  ]);
  assert.deepEqual(client.listed, ['a']);
});

test('a per-repo opt-in is fixed even when not allowlisted', async (t) => {
  const fx = await fixture(t);
  const { fixer } = makeFixer(fx, [fx.pr]);
  const cfg = config({ conflictFixer: true });
  cfg.conflictFixer = { ...cfg.conflictFixer, mode: 'allowlist', allowlist: [], denylist: ['me/demo'] };

  const result = await fixer.run(cfg);

  assert.equal(result.results[0].status, 'fixed', result.results[0].reason);
});
