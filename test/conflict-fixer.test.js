import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-fixer-lock-'));
process.env.SDG_RUN_LOCK_FILE = path.join(lockDir, 'run.lock');

const { default: ConflictFixer, isConflicted, selectRepositories, summarize } = await import('../src/core/conflict-fixer.js');
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
  return { root, work, remote, workRoot, pr, remoteHead };
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
    ...options
  });
  return { fixer, client };
}

function config(repoOverrides = {}) {
  return {
    general: { dryRun: false },
    repositories: [{ owner: 'me', repo: 'demo', enabled: true, testCommand: null, ...repoOverrides }],
    conflictFixer: { testTimeoutMinutes: 1, installDeps: true }
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
    { status: 'error', success: false, skipped: true }
  ]);
  assert.deepEqual(summary, { total: 5, fixed: 2, needsManualReview: 1, skipped: 2, failed: 1 });
});

test('fixes a conflicted PR, pushes a merge commit, and cleans up', async (t) => {
  const fx = await fixture(t);
  const { fixer } = makeFixer(fx, [fx.pr]);

  const result = await fixer.run(config());

  assert.equal(result.success, true, result.error);
  assert.equal(result.results[0].status, 'fixed', result.results[0].reason);
  assert.deepEqual(result.summary, { total: 1, fixed: 1, needsManualReview: 0, skipped: 0, failed: 0 });

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
