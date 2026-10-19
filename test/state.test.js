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

test('lastCommitDate tracks the last recorded commit, not the last window check', () => {
  const sm = new StateManager({ filePath: tmpStateFile() });
  const tz = 'Asia/Manila';
  const commitDay = new Date('2025-03-10T02:00:00Z'); // 2025-03-10 10:00 in Manila
  const laterDay = new Date('2025-03-14T02:00:00Z');

  // Window checks and issue actions on a fresh repo do not invent a commit date
  sm.isWithinLimits('me', 'demo', { dailyMax: 1 }, tz, commitDay);
  sm.recordAction('me', 'demo', { type: 'issue', timezone: tz, now: commitDay });
  assert.equal(sm.getRepoState('me', 'demo').lastCommitDate, null);

  sm.recordCommit('me', 'demo', tz, commitDay);
  assert.equal(sm.getRepoState('me', 'demo').lastCommitDate, '2025-03-10');

  // Rolling into a later day resets today's count but keeps the real last commit date
  sm.isWithinLimits('me', 'demo', { dailyMax: 1 }, tz, laterDay);
  const repoState = sm.getRepoState('me', 'demo');
  assert.equal(repoState.lastCommitDate, '2025-03-10');
  assert.equal(repoState.commitsToday, 0);

  sm.recordCommit('me', 'demo', tz, laterDay);
  assert.equal(sm.getRepoState('me', 'demo').lastCommitDate, '2025-03-14');
});

test('getDailyTarget rolls a range once per day and keeps it across reloads', () => {
  const filePath = tmpStateFile();
  const sm = new StateManager({ filePath });
  const day1 = new Date('2026-10-18T10:00:00Z');
  const range = { min: 3, max: 8 };

  const target = sm.getDailyTarget('me', 'demo', range, 'UTC', day1);
  assert.ok(Number.isInteger(target) && target >= 3 && target <= 8);
  for (let i = 0; i < 20; i++) {
    assert.equal(sm.getDailyTarget('me', 'demo', range, 'UTC', day1), target);
  }
  assert.equal(new StateManager({ filePath }).getDailyTarget('me', 'demo', range, 'UTC', day1), target);
});

test('getDailyTarget re-rolls on a new day or a changed range, and returns fixed targets as-is', () => {
  const sm = new StateManager({ filePath: tmpStateFile() });
  const day1 = new Date('2026-10-18T10:00:00Z');
  const day2 = new Date('2026-10-19T10:00:00Z');

  sm.getDailyTarget('me', 'demo', { min: 1, max: 100 }, 'UTC', day1);
  sm.getDailyTarget('me', 'demo', { min: 1, max: 100 }, 'UTC', day2);
  assert.equal(sm.getRepoState('me', 'demo').dailyTarget.day, '2026-10-19');

  const narrowed = sm.getDailyTarget('me', 'demo', { min: 4, max: 5 }, 'UTC', day2);
  assert.ok(narrowed === 4 || narrowed === 5);
  assert.deepEqual(sm.getRepoState('me', 'demo').dailyTarget, { day: '2026-10-19', min: 4, max: 5, value: narrowed });

  assert.equal(sm.getDailyTarget('me', 'fixed', { min: 7, max: 7 }, 'UTC', day1), 7);
  assert.equal(sm.getRepoState('me', 'fixed').dailyTarget, undefined);
});

test('getDailyTarget ignores a malformed saved target', () => {
  const sm = new StateManager({ filePath: tmpStateFile() });
  const now = new Date('2026-10-18T10:00:00Z');
  sm.getRepoState('me', 'demo').dailyTarget = { day: '2026-10-18', min: 2, max: 3, value: 'lots' };

  const target = sm.getDailyTarget('me', 'demo', { min: 2, max: 3 }, 'UTC', now);
  assert.ok(target === 2 || target === 3);
});
