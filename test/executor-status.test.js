import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Isolate state and run lock before the executor imports them
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-executor-'));
process.env.SDG_STATE_FILE = path.join(stateDir, 'state.json');
process.env.GITHUB_TOKEN = 'ghp_test';

const { default: executor } = await import('../src/core/executor.js');
const { default: config } = await import('../src/config/loader.js');
const { default: state } = await import('../src/utils/state.js');

test('getStatus in simple issue mode reports issues created today in the configured timezone', async (t) => {
  // 12:00 UTC on Oct 14 is already Oct 15 in Kiritimati (UTC+14), so a UTC lookup would see a different day
  mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-14T12:00:00Z') });
  t.after(() => mock.timers.reset());

  const timezone = 'Pacific/Kiritimati';
  config.config = {
    general: { mode: 'issue', timezone, dryRun: false },
    repositories: [{ owner: 'me', repo: 'simple', enabled: true, dailyTarget: 2 }]
  };

  state.recordAction('me', 'simple', { type: 'issue', timezone });

  const result = await executor.getStatus();
  assert.equal(result.success, true);
  const [status] = result.status;
  assert.equal(status.today, 1);
  assert.equal(status.target, 2);
  assert.equal(status.needsCommit, true);

  state.recordAction('me', 'simple', { type: 'issue', timezone });
  const [after] = (await executor.getStatus()).status;
  assert.equal(after.today, 2);
  assert.equal(after.needsCommit, false);
});

test('getStatus leaves disabled repositories out of the commit-mode table and names them separately', async () => {
  config.config = {
    general: { mode: 'commit', timezone: 'UTC', dryRun: false },
    repositories: [
      { owner: 'me', repo: 'active', enabled: true, dailyTarget: 1 },
      { owner: 'me', repo: 'paused', enabled: false, dailyTarget: 1 }
    ]
  };

  const result = await executor.getStatus();
  assert.equal(result.success, true);
  assert.deepEqual(result.status.map(s => `${s.owner}/${s.repo}`), ['me/active']);
  assert.deepEqual(result.disabled, ['me/paused']);
});

test('getStatus leaves disabled repositories out of advanced issue-mode status', async () => {
  process.env.SDG_ISSUE_STATE_FILE = path.join(stateDir, 'issue-state.json');
  config.config = {
    general: { mode: 'issue', timezone: 'UTC', dryRun: false },
    repositories: [
      { owner: 'me', repo: 'active', enabled: true, dailyTarget: { min: 1, max: 3 } },
      { owner: 'me', repo: 'paused', enabled: false, dailyTarget: { min: 1, max: 3 }, intervalMinutes: 60 }
    ]
  };

  const result = await executor.getStatus();
  assert.equal(result.success, true);
  assert.deepEqual(result.status.repositories.map(s => s.repo), ['me/active']);
  assert.deepEqual(result.disabled, ['me/paused']);
});

test('getStatus reports no disabled repositories when all are enabled', async () => {
  config.config = {
    general: { mode: 'commit', timezone: 'UTC', dryRun: false },
    repositories: [{ owner: 'me', repo: 'active', enabled: true, dailyTarget: 1 }]
  };

  const result = await executor.getStatus();
  assert.deepEqual(result.disabled, []);
});
