import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { StateManager } from '../src/utils/state.js';

const NOW = new Date(Date.UTC(2025, 0, 6, 10, 0, 0));
const DAY = '2025-01-06';

function managerWith(state) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-state-malformed-'));
  const filePath = path.join(dir, 'state.json');
  fs.writeFileSync(filePath, JSON.stringify(state));
  return { sm: new StateManager({ filePath }), filePath };
}

test('a repo whose counters lack a window does not crash the limit check', () => {
  const { sm } = managerWith({ repositories: { 'me/demo': { counters: { daily: { key: DAY, count: 2 } } } } });

  const check = sm.isWithinLimits('me', 'demo', { dailyMax: 5 }, 'UTC', NOW);
  assert.equal(check.allowed, true);
  assert.deepEqual(check.counts, { hourly: 0, daily: 2, weekly: 0 });
});

test('a window without a numeric count starts at zero instead of blocking the repo', () => {
  const { sm, filePath } = managerWith({
    repositories: {
      'me/demo': {
        counters: {
          hourly: { key: `${DAY}T10` },
          daily: { key: DAY, count: 'three' },
          weekly: { key: '2025-W02', count: null }
        },
        totals: { issues: null }
      }
    }
  });

  assert.equal(sm.isWithinLimits('me', 'demo', { dailyMax: 1 }, 'UTC', NOW).allowed, true);
  sm.recordAction('me', 'demo', { type: 'commit', timezone: 'UTC', now: NOW });

  const saved = JSON.parse(fs.readFileSync(filePath, 'utf8')).repositories['me/demo'];
  assert.deepEqual(
    [saved.counters.hourly.count, saved.counters.daily.count, saved.counters.weekly.count],
    [1, 1, 1]
  );
  assert.deepEqual(saved.totals, { issues: 0, commits: 1 });
});

test('non-object counters, totals, and repo entries are replaced with fresh ones', () => {
  const { sm } = managerWith({
    repositories: {
      'me/demo': { counters: 'broken', totals: [] },
      'me/other': 'broken'
    }
  });

  sm.recordAction('me', 'demo', { type: 'issue', timezone: 'UTC', now: NOW });
  assert.deepEqual(sm.getCounts('me', 'demo', 'UTC', NOW), { hourly: 1, daily: 1, weekly: 1 });
  assert.deepEqual(sm.getRepoState('me', 'demo').totals, { issues: 1, commits: 0 });

  sm.recordAction('me', 'other', { type: 'commit', timezone: 'UTC', now: NOW });
  assert.deepEqual(sm.getCounts('me', 'other', 'UTC', NOW), { hourly: 1, daily: 1, weekly: 1 });
});

test('a repositories field that is not an object starts fresh so state persists', () => {
  const { sm, filePath } = managerWith({ repositories: [], roundRobin: { index: 2 } });

  sm.recordAction('me', 'demo', { type: 'issue', timezone: 'UTC', now: NOW });

  const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(saved.repositories['me/demo'].counters.daily.count, 1);
});

test('well-formed counters are left untouched', () => {
  const { sm } = managerWith({
    repositories: {
      'me/demo': {
        counters: {
          hourly: { key: `${DAY}T10`, count: 1 },
          daily: { key: DAY, count: 3 },
          weekly: { key: '2025-W02', count: 7 }
        },
        totals: { issues: 4, commits: 9 }
      }
    }
  });

  assert.deepEqual(sm.getCounts('me', 'demo', 'UTC', NOW), { hourly: 1, daily: 3, weekly: 7 });
  assert.deepEqual(sm.getRepoState('me', 'demo').totals, { issues: 4, commits: 9 });
});
