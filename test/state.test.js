import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { StateManager } from '../src/utils/state.js';

function tmpStateFile(name = 'state-test.json') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-state-'));
  return path.join(dir, name);
}

test('StateManager initializes and persists counters', () => {
  const filePath = tmpStateFile();
  const sm = new StateManager({ filePath });

  const owner = 'me';
  const repo = 'demo';

  // Initially allowed with zero counts
  let check = sm.isWithinLimits(owner, repo, { dailyMax: 1 }, 'UTC');
  assert.equal(check.allowed, true);
  assert.equal(check.counts.daily, 0);

  // Record one action
  sm.recordAction(owner, repo, { type: 'issue', timezone: 'UTC' });
  check = sm.isWithinLimits(owner, repo, { dailyMax: 1 }, 'UTC');
  assert.equal(check.allowed, false);
  assert.equal(check.counts.daily, 1);

  // Reload from disk and confirm persistence
  const sm2 = new StateManager({ filePath });
  const check2 = sm2.isWithinLimits(owner, repo, { dailyMax: 1 }, 'UTC');
  assert.equal(check2.allowed, false);
  assert.equal(check2.counts.daily, 1);
});

test('Hourly/Daily/Weekly windows reset across boundaries', () => {
  const filePath = tmpStateFile();
  const sm = new StateManager({ filePath });
  const owner = 'me';
  const repo = 'demo';
  const tz = 'UTC';

  // Set a fixed time
  const t1 = new Date(Date.UTC(2025, 0, 6, 10, 0, 0)); // Mon Jan 6 2025 10:00 UTC (ISO week 2)
  sm.ensureWindows(owner, repo, tz, t1);
  sm.recordAction(owner, repo, { type: 'issue', timezone: tz, now: t1 });

  // Same hour/day/week should not reset
  let counters = sm.ensureWindows(owner, repo, tz, new Date(Date.UTC(2025, 0, 6, 10, 30, 0)));
  assert.equal(counters.hourly.count, 1);
  assert.equal(counters.daily.count, 1);
  assert.equal(counters.weekly.count, 1);

  // Next hour: hourly resets, others persist
  counters = sm.ensureWindows(owner, repo, tz, new Date(Date.UTC(2025, 0, 6, 11, 0, 0)));
  assert.equal(counters.hourly.count, 0);
  assert.equal(counters.daily.count, 1);
  assert.equal(counters.weekly.count, 1);

  // Next day: daily resets, weekly persists
  counters = sm.ensureWindows(owner, repo, tz, new Date(Date.UTC(2025, 0, 7, 9, 0, 0)));
  assert.equal(counters.daily.count, 0);
  assert.equal(counters.weekly.count, 1);

  // Next week: weekly resets
  counters = sm.ensureWindows(owner, repo, tz, new Date(Date.UTC(2025, 0, 13, 9, 0, 0))); // Next Monday
  assert.equal(counters.weekly.count, 0);
});

test('Backward compatibility: isCommitNeeded and recordCommit map to daily', () => {
  const filePath = tmpStateFile();
  const sm = new StateManager({ filePath });
  const owner = 'me';
  const repo = 'demo';
  const tz = 'UTC';

  // Need one commit
  assert.equal(sm.isCommitNeeded(owner, repo, 1, tz), true);
  sm.recordCommit(owner, repo, tz);
  assert.equal(sm.isCommitNeeded(owner, repo, 1, tz), false);
});

test('StateManager persists the round-robin cursor', () => {
  const filePath = tmpStateFile();
  const sm = new StateManager({ filePath });
  assert.equal(sm.getRoundRobinIndex(), 0);

  sm.setRoundRobinIndex(3);
  assert.equal(new StateManager({ filePath }).getRoundRobinIndex(), 3);

  // Invalid persisted values fall back to the start of the rotation
  fs.writeFileSync(filePath, JSON.stringify({ repositories: {}, roundRobin: { index: -2 } }));
  assert.equal(new StateManager({ filePath }).getRoundRobinIndex(), 0);
});

test('save writes atomically and leaves no temp file behind', () => {
  const filePath = tmpStateFile();
  const sm = new StateManager({ filePath });

  sm.recordAction('me', 'demo', { type: 'commit', timezone: 'UTC' });

  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(parsed.repositories['me/demo'].totals.commits, 1);
  assert.deepEqual(fs.readdirSync(path.dirname(filePath)), [path.basename(filePath)]);
});

test('crash mid-write keeps the previous state file intact and cleans up the temp file', (t) => {
  const filePath = tmpStateFile();
  const sm = new StateManager({ filePath });
  sm.recordAction('me', 'demo', { type: 'commit', timezone: 'UTC' });

  // Simulate the process dying halfway through serializing the state
  const realWrite = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', (file, data) => {
    realWrite(file, String(data).slice(0, 10));
    throw new Error('simulated crash');
  });
  t.mock.method(console, 'error', () => {});

  sm.recordAction('me', 'demo', { type: 'commit', timezone: 'UTC' });
  fs.writeFileSync.mock.restore();

  assert.deepEqual(fs.readdirSync(path.dirname(filePath)), [path.basename(filePath)]);
  const reloaded = new StateManager({ filePath });
  assert.equal(reloaded.getRepoState('me', 'demo').totals.commits, 1);
});
