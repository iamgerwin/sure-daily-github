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

test('a malformed repositories field keeps the round-robin cursor and backs up the file', () => {
  const original = { repositories: [], roundRobin: { index: 2 } };
  const { sm, filePath } = managerWith(original);

  assert.equal(sm.getRoundRobinIndex(), 2);
  assert.deepEqual(JSON.parse(fs.readFileSync(`${filePath}.bak`, 'utf8')), original);

  sm.recordAction('me', 'demo', { type: 'issue', timezone: 'UTC', now: NOW });
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')).roundRobin, { index: 2 });
});

test('state that is valid JSON but not an object is backed up before starting fresh', () => {
  const { sm, filePath } = managerWith([{ 'me/demo': { totalCommits: 40 } }]);

  assert.deepEqual(sm.state.repositories, {});
  assert.deepEqual(JSON.parse(fs.readFileSync(`${filePath}.bak`, 'utf8')), [{ 'me/demo': { totalCommits: 40 } }]);

  sm.recordAction('me', 'demo', { type: 'commit', timezone: 'UTC', now: NOW });
  assert.equal(fs.existsSync(`${filePath}.bak`), true);
});

test('well-formed state is not backed up', () => {
  const { filePath } = managerWith({ repositories: {} });
  assert.equal(fs.existsSync(`${filePath}.bak`), false);
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

test('malformed legacy commit fields are reset instead of concatenating or reading undefined', () => {
  const { sm, filePath } = managerWith({
    repositories: {
      'me/demo': { totalCommits: '5', commitsToday: -1, lastCommitDate: 42 },
      'me/bare': { counters: { daily: { key: DAY, count: 0 } } }
    }
  });

  sm.recordAction('me', 'demo', { type: 'commit', timezone: 'UTC', now: NOW });
  const saved = JSON.parse(fs.readFileSync(filePath, 'utf8')).repositories['me/demo'];
  assert.equal(saved.totalCommits, 1);
  assert.equal(saved.commitsToday, 1);
  assert.equal(saved.lastCommitDate, DAY);

  sm.getCounts('me', 'bare', 'UTC', NOW);
  const bare = sm.getRepoState('me', 'bare');
  assert.equal(bare.totalCommits, 0);
  assert.equal(bare.commitsToday, 0);
  assert.equal(bare.lastCommitDate, null);
});

test('well-formed legacy commit fields are kept', () => {
  const { sm } = managerWith({
    repositories: { 'me/demo': { totalCommits: 12, commitsToday: 2, lastCommitDate: '2025-01-05' } }
  });

  sm.getCounts('me', 'demo', 'UTC', NOW);
  const repo = sm.getRepoState('me', 'demo');
  // A new day resets commitsToday; the total and last commit date survive
  assert.equal(repo.totalCommits, 12);
  assert.equal(repo.commitsToday, 0);
  assert.equal(repo.lastCommitDate, '2025-01-05');
});
