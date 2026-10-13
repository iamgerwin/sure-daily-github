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
