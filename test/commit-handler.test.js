import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Point the shared StateManager at a temp file before the handler imports it
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-commit-'));
process.env.SDG_STATE_FILE = path.join(stateDir, 'state.json');

const { default: CommitHandler } = await import('../src/github/commit-handler.js');
const { default: state } = await import('../src/utils/state.js');

// Shape produced by config loader normalization
const repoConfig = {
  owner: 'me',
  repo: 'demo',
  enabled: true,
  branch: 'main',
  dailyTarget: { min: 2, max: 2 },
  path: 'daily-updates',
  commitMessage: 'docs: daily update ${date}'
};

test('createDailyCommit proceeds when normalized dailyTarget is not yet met', async () => {
  const handler = new CommitHandler('ghp_test');
  const result = await handler.createDailyCommit(repoConfig, {}, true);
  assert.equal(result.skipped, undefined);
  assert.equal(result.dryRun, true);
});

test('createDailyCommit commits until dailyTarget.max, then skips', async () => {
  const handler = new CommitHandler('ghp_test');
  const calls = [];
  handler.client = {
    createOrUpdateFile: async (...args) => {
      calls.push(args);
      return { success: true, data: { commit: { sha: `sha${calls.length}` } } };
    }
  };

  const first = await handler.createDailyCommit({ ...repoConfig, repo: 'limit' }, {}, false);
  const second = await handler.createDailyCommit({ ...repoConfig, repo: 'limit' }, {}, false);
  const third = await handler.createDailyCommit({ ...repoConfig, repo: 'limit' }, {}, false);

  assert.equal(first.success, true);
  assert.equal(second.success, true);
  assert.equal(third.skipped, true);
  assert.equal(calls.length, 2);
  assert.equal(state.getCounts('me', 'limit').daily, 2);
});

test('getStatus reports a numeric target for normalized dailyTarget', async () => {
  const handler = new CommitHandler('ghp_test');
  const [status] = await handler.getStatus([{ ...repoConfig, repo: 'status' }]);
  assert.equal(status.target, 2);
  assert.equal(status.needsCommit, true);
});

test('getStatus counts issue actions toward today (simple issue mode)', async () => {
  const handler = new CommitHandler('ghp_test');
  state.recordAction('me', 'issues', { type: 'issue' });
  state.recordAction('me', 'issues', { type: 'issue' });

  const [status] = await handler.getStatus([{ ...repoConfig, repo: 'issues' }]);
  assert.equal(status.today, 2);
  assert.equal(status.needsCommit, false);
});

test('getStatus does not report a commit for a repository that never committed', async () => {
  const handler = new CommitHandler('ghp_test');
  state.recordAction('me', 'no-commits', { type: 'issue' });

  const [status] = await handler.getStatus([{ ...repoConfig, repo: 'no-commits' }]);
  assert.equal(status.lastCommit, null);
  assert.equal(status.total, 0);
});

test('commit message, file path and content use the configured timezone date', async () => {
  const handler = new CommitHandler('ghp_test');
  const now = new Date('2026-10-14T23:30:05Z');

  assert.equal(handler.generateCommitMessage('docs: ${date} ${repo}', 'demo', 'Asia/Manila', now), 'docs: 2026-10-15 demo');
  assert.equal(handler.generateFilePath('daily', 'demo', 'Asia/Manila', now), `daily/2026-10-15-${now.getTime()}.md`);
  assert.equal(handler.generateContent({ body: '${date} ${time}' }, 'Asia/Manila', now), '2026-10-15 07:30:05');
});

test('createDailyCommit renders templates in the configured timezone', async () => {
  const handler = new CommitHandler('ghp_test');
  const calls = [];
  handler.client = {
    createOrUpdateFile: async (...args) => {
      calls.push(args);
      return { success: true, data: { commit: { sha: 'sha' } } };
    }
  };
  // Pick a zone whose local date differs from UTC right now
  const utcDate = new Date().toISOString().split('T')[0];
  const timezone = ['Pacific/Kiritimati', 'Pacific/Pago_Pago']
    .find(tz => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date()) !== utcDate);
  const localDate = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date());

  await handler.createDailyCommit({ ...repoConfig, repo: 'tz' }, { body: '${date}' }, false, timezone);

  const [, , filePath, content, message] = calls[0];
  assert.equal(message, `docs: daily update ${localDate}`);
  assert.equal(content, localDate);
  assert.ok(filePath.startsWith(`daily-updates/${localDate}-`));
});

test('commit message renders ${time} and ${timestamp} like the content template', () => {
  const handler = new CommitHandler('ghp_test');
  const now = new Date('2026-10-14T23:30:05Z');

  assert.equal(
    handler.generateCommitMessage('docs: ${repo} ${date} ${time} (${timestamp})', 'demo', 'Asia/Manila', now),
    'docs: demo 2026-10-15 07:30:05 (2026-10-14T23:30:05.000Z)'
  );
});

test('createDailyCommit dates the message, file and content from one clock reading', async () => {
  const handler = new CommitHandler('ghp_test');
  const calls = [];
  handler.client = {
    createOrUpdateFile: async (...args) => {
      calls.push(args);
      return { success: true, data: { commit: { sha: 'sha' } } };
    }
  };
  const now = new Date('2026-10-14T15:59:59Z'); // 23:59:59 in Asia/Manila

  await handler.createDailyCommit(
    { ...repoConfig, repo: 'clock', commitMessage: 'docs: ${date} ${time}' },
    { body: '${date} ${time}' },
    false,
    'Asia/Manila',
    now
  );

  const [, , filePath, content, message] = calls[0];
  assert.equal(message, 'docs: 2026-10-14 23:59:59');
  assert.equal(content, '2026-10-14 23:59:59');
  assert.equal(filePath, `daily-updates/2026-10-14-${now.getTime()}.md`);
});

function stubbedHandler() {
  const handler = new CommitHandler('ghp_test');
  const calls = [];
  handler.delay = async () => {};
  handler.client = {
    createOrUpdateFile: async (owner, repo) => {
      calls.push(repo);
      return { success: true, data: { commit: { sha: 'sha' } } };
    }
  };
  return { handler, calls };
}

const selectionRepos = ['sel-a', 'sel-b', 'sel-c'].map(repo => ({ ...repoConfig, repo, dailyTarget: { min: 1, max: 1 } }));

test('processRepositories commits to every enabled repo when repositorySelection is omitted', async () => {
  const { handler, calls } = stubbedHandler();
  const repos = [
    ...selectionRepos.map(r => ({ ...r, repo: `all-${r.repo}` })),
    { ...repoConfig, repo: 'all-disabled', enabled: false }
  ];

  const results = await handler.processRepositories(repos, {}, false, {});

  assert.deepEqual(calls, ['all-sel-a', 'all-sel-b', 'all-sel-c']);
  assert.equal(results.length, 3);
  assert.ok(results.every(r => r.success && !r.skipped));
});

test('processRepositories honors repositorySelection.maxPerExecution in commit mode', async () => {
  const { handler, calls } = stubbedHandler();
  const repos = selectionRepos.map(r => ({ ...r, repo: `max-${r.repo}` }));

  const results = await handler.processRepositories(repos, {}, false, {
    repositorySelection: { strategy: 'sequential', maxPerExecution: 1 }
  });

  assert.deepEqual(calls, ['max-sel-a']);
  const notSelected = results.filter(r => r.reason === 'not_selected').map(r => r.repo);
  assert.deepEqual(notSelected, ['max-sel-b', 'max-sel-c']);
  assert.ok(results.every(r => r.success));
});

test('processRepositories does not spend selection slots on repos whose target is met', async () => {
  const { handler, calls } = stubbedHandler();
  const repos = selectionRepos.map(r => ({ ...r, repo: `met-${r.repo}` }));
  state.recordCommit('me', 'met-sel-a');

  const results = await handler.processRepositories(repos, {}, false, {
    repositorySelection: { strategy: 'sequential', maxPerExecution: 1 }
  });

  assert.deepEqual(calls, ['met-sel-b']);
  assert.equal(results.find(r => r.repo === 'met-sel-a').reason, 'target_met');
  assert.equal(results.find(r => r.repo === 'met-sel-c').reason, 'not_selected');
});

test('processRepositories rotates repos across runs with round-robin in commit mode', async () => {
  const { handler, calls } = stubbedHandler();
  const repos = selectionRepos.map(r => ({ ...r, repo: `rr-${r.repo}`, dailyTarget: { min: 5, max: 5 } }));
  const config = { repositorySelection: { strategy: 'round-robin', maxPerExecution: 1 } };
  state.setRoundRobinIndex(0);

  await handler.processRepositories(repos, {}, false, config);
  await handler.processRepositories(repos, {}, false, config);
  await handler.processRepositories(repos, {}, false, config);

  assert.deepEqual(calls, ['rr-sel-a', 'rr-sel-b', 'rr-sel-c']);
});

test('createDailyCommit stops at the rolled daily target, not always dailyTarget.max', async () => {
  const { handler, calls } = stubbedHandler();
  const ranged = { ...repoConfig, repo: 'ranged', dailyTarget: { min: 1, max: 3 } };
  const target = handler.resolveDailyTarget(ranged);
  assert.ok(target >= 1 && target <= 3);

  for (let i = 0; i < 5; i++) await handler.createDailyCommit(ranged, {}, false);

  assert.equal(calls.length, target);
  assert.equal(state.getCounts('me', 'ranged').daily, target);
});

test('getStatus reports the same rolled target the run uses', async () => {
  const handler = new CommitHandler('ghp_test');
  const ranged = { ...repoConfig, repo: 'ranged-status', dailyTarget: { min: 1, max: 50 } };
  const target = handler.resolveDailyTarget(ranged);

  const [status] = await handler.getStatus([ranged]);
  assert.equal(status.target, target);
});

test('processRepositories waits between commits but not after the last repo', async () => {
  const { handler, calls } = stubbedHandler();
  const delays = [];
  handler.delay = async (ms) => { delays.push(ms); };
  const repos = selectionRepos.map(r => ({ ...r, repo: `pace-${r.repo}` }));

  await handler.processRepositories(repos, {}, false, {});

  assert.equal(calls.length, 3);
  assert.deepEqual(delays, [1000, 1000]);
});

test('processRepositories does not wait on rate-limit delays in a dry run', async () => {
  const { handler, calls } = stubbedHandler();
  const delays = [];
  handler.delay = async (ms) => { delays.push(ms); };
  const repos = selectionRepos.map(r => ({ ...r, repo: `pace-dry-${r.repo}` }));

  const results = await handler.processRepositories(repos, {}, true, {});

  assert.equal(calls.length, 0);
  assert.ok(results.every(r => r.dryRun));
  assert.deepEqual(delays, []);
});
