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
