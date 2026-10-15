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
