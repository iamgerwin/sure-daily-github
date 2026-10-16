import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Isolate state before the executor imports it
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-exit-code-'));
process.env.SDG_STATE_FILE = path.join(stateDir, 'state.json');

const { getRunExitCode, describeFailures } = await import('../src/core/executor.js');

const summary = (failed) => ({ total: 2, successful: 2 - failed, skipped: 0, failed });

test('getRunExitCode is 0 when every repository succeeded or was skipped', () => {
  assert.equal(getRunExitCode({ success: true, results: [], summary: summary(0) }), 0);
  assert.equal(getRunExitCode({ success: true, results: [], summary: { total: 1, successful: 0, skipped: 1, failed: 0 } }), 0);
});

test('getRunExitCode is 1 when any repository failed', () => {
  assert.equal(getRunExitCode({ success: true, results: [], summary: summary(1) }), 1);
  assert.equal(getRunExitCode({ success: true, results: [], summary: summary(2) }), 1);
});

test('getRunExitCode is 1 when the run itself failed or returned nothing', () => {
  assert.equal(getRunExitCode({ success: false, error: 'GitHub authentication failed' }), 1);
  assert.equal(getRunExitCode({ success: false, locked: true, error: 'Another execution is already in progress' }), 1);
  assert.equal(getRunExitCode(undefined), 1);
});

test('describeFailures lists only failed repositories with their error', () => {
  const lines = describeFailures([
    { owner: 'me', repo: 'ok', success: true },
    { owner: 'me', repo: 'skipped', success: true, skipped: true, reason: 'target_met' },
    { owner: 'me', repo: 'broken', success: false, error: 'Not Found' }
  ]);
  assert.deepEqual(lines, ['me/broken: Not Found']);
});

test('describeFailures falls back to the first failed detail of a multi-issue result', () => {
  const lines = describeFailures([
    {
      owner: 'me',
      repo: 'multi',
      success: false,
      details: [{ success: false, error: 'Validation Failed' }]
    },
    { owner: 'me', repo: 'silent', success: false }
  ]);
  assert.deepEqual(lines, ['me/multi: Validation Failed', 'me/silent: unknown error']);
});
