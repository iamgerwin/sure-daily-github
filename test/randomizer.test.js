import test from 'node:test';
import assert from 'node:assert/strict';
import randomizer from '../src/utils/randomizer.js';

test('randomInt returns min when min == max', () => {
  assert.equal(randomizer.randomInt(5, 5), 5);
});

test('randomInt throws when min > max', () => {
  assert.throws(() => randomizer.randomInt(10, 1), /min cannot be greater than max/);
});

test('getRandomCount defaults to 1 for invalid config', () => {
  assert.equal(randomizer.getRandomCount(null), 1);
  assert.equal(randomizer.getRandomCount({}), 1);
  assert.equal(randomizer.getRandomCount({ min: 2 }), 1);
});

test('getRandomCount respects range via stubbed randomInt', () => {
  const original = randomizer.randomInt.bind(randomizer);
  try {
    // Always pick max
    randomizer.randomInt = () => 7;
    assert.equal(randomizer.getRandomCount({ min: 3, max: 7 }), 7);

    // Always pick min
    randomizer.randomInt = () => 3;
    assert.equal(randomizer.getRandomCount({ min: 3, max: 7 }), 3);
  } finally {
    randomizer.randomInt = original;
  }
});

test('getRandomCountWithTimeVariation disabled returns null', () => {
  assert.equal(randomizer.getRandomCountWithTimeVariation({ enabled: false }), null);
});

test('getRandomCountWithTimeVariation uses base issueCount when TV disabled', () => {
  const original = randomizer.randomInt.bind(randomizer);
  try {
    randomizer.randomInt = () => 25;
    const cfg = {
      enabled: true,
      issueCount: { min: 10, max: 25 },
      timeVariations: { enabled: false }
    };
    assert.equal(randomizer.getRandomCountWithTimeVariation(cfg, 'daily'), 25);
  } finally {
    randomizer.randomInt = original;
  }
});

test('getRandomCountWithTimeVariation honors hourly/daily/weekly ranges', () => {
  const original = randomizer.randomInt.bind(randomizer);
  try {
    randomizer.randomInt = () => 4;
    const cfg = {
      enabled: true,
      timeVariations: {
        enabled: true,
        hourly: { min: 1, max: 4 },
        daily: { min: 2, max: 4 },
        weekly: { min: 3, max: 4 }
      }
    };
    assert.equal(randomizer.getRandomCountWithTimeVariation(cfg, 'hourly'), 4);
    assert.equal(randomizer.getRandomCountWithTimeVariation(cfg, 'daily'), 4);
    assert.equal(randomizer.getRandomCountWithTimeVariation(cfg, 'weekly'), 4);
  } finally {
    randomizer.randomInt = original;
  }
});

test('getRandomCountWithTimeVariation falls back to issueCount when daily range is missing', () => {
  const original = randomizer.randomInt.bind(randomizer);
  try {
    randomizer.randomInt = (min, max) => max;
    const cfg = {
      enabled: true,
      issueCount: { min: 6, max: 9 },
      timeVariations: {
        enabled: true,
        hourly: { min: 1, max: 4 },
        weekly: { min: 3, max: 40 }
      }
    };
    assert.equal(randomizer.getRandomCountWithTimeVariation(cfg, 'daily'), 9);
    assert.equal(randomizer.getRandomCountWithTimeVariation(cfg), 9);
    // A configured daily range still wins over issueCount
    cfg.timeVariations.daily = { min: 2, max: 5 };
    assert.equal(randomizer.getRandomCountWithTimeVariation(cfg, 'daily'), 5);
  } finally {
    randomizer.randomInt = original;
  }
});

test('selectRepositories sequential respects maxPerExecution and order', () => {
  const repos = [
    { id: 'a', enabled: true },
    { id: 'b', enabled: true },
    { id: 'c', enabled: true }
  ];

  const selected = randomizer.selectRepositories(repos, { strategy: 'sequential', maxPerExecution: 2 });
  assert.equal(selected.length, 2);
  assert.deepEqual(selected.map(r => r.id), ['a', 'b']);
});

test('selectRepositories weighted uses weights (stubbed Math.random sequence)', () => {
  const repos = [
    { id: 'A', enabled: true, weight: 50 },
    { id: 'B', enabled: true, weight: 30 },
    { id: 'C', enabled: true, weight: 20 }
  ];

  // Stub Math.random with a sequence
  const seq = [0.0, 0.99];
  let idx = 0;
  const originalRandom = Math.random;
  Math.random = () => seq[idx++ % seq.length];

  try {
    const selected = randomizer.selectRepositories(repos, { strategy: 'weighted', maxPerExecution: 2 });
    assert.equal(selected.length, 2);
    // With the sequence above, first pick should be 'A', second should be 'C'
    assert.equal(selected[0].id, 'A');
    assert.equal(selected[1].id, 'C');
  } finally {
    Math.random = originalRandom;
  }
});

test('selectRepositories weighted picks the last repo when rounding leaves a remainder', () => {
  // 0.7 + 2.3 + 0.2 rounds so that subtracting each weight from the top draw stays above zero
  const repos = [
    { id: 'A', enabled: true, weight: 0.7 },
    { id: 'B', enabled: true, weight: 2.3 },
    { id: 'C', enabled: true, weight: 0.2 }
  ];

  const originalRandom = Math.random;
  Math.random = () => 0.9999999999999999;

  try {
    const selected = randomizer.selectRepositories(repos, { strategy: 'weighted', maxPerExecution: 1 });
    assert.deepEqual(selected.map(repo => repo.id), ['C']);
  } finally {
    Math.random = originalRandom;
  }
});

test('selectRoundRobinRepositories rotates from index', () => {
  const repos = [
    { id: 'a' },
    { id: 'b' },
    { id: 'c' },
    { id: 'd' }
  ];
  const selected = randomizer.selectRoundRobinRepositories(repos, 2, 1);
  assert.deepEqual(selected.map(r => r.id), ['b', 'c']);
});


function memoryCursorStore(index = 0) {
  return {
    index,
    getRoundRobinIndex() { return this.index; },
    setRoundRobinIndex(next) { this.index = next; }
  };
}

test('selectRoundRobinRepositories never selects a repository twice', () => {
  const repos = [{ id: 'a' }, { id: 'b' }];
  const selected = randomizer.selectRoundRobinRepositories(repos, 5, 1);
  assert.deepEqual(selected.map(r => r.id), ['b', 'a']);
});

test('selectRepositories round-robin advances the cursor across runs', () => {
  const repos = ['a', 'b', 'c'].map(id => ({ id, enabled: true }));
  const store = memoryCursorStore();
  const cfg = { strategy: 'round-robin', maxPerExecution: 2 };

  assert.deepEqual(randomizer.selectRepositories(repos, cfg, store).map(r => r.id), ['a', 'b']);
  assert.equal(store.index, 2);
  assert.deepEqual(randomizer.selectRepositories(repos, cfg, store).map(r => r.id), ['c', 'a']);
  assert.equal(store.index, 1);
  assert.deepEqual(randomizer.selectRepositories(repos, cfg, store).map(r => r.id), ['b', 'c']);
});

test('selectRepositories round-robin dry run previews the pick without moving the cursor', () => {
  const repos = ['a', 'b', 'c'].map(id => ({ id, enabled: true }));
  const store = memoryCursorStore(1);
  const cfg = { strategy: 'round-robin', maxPerExecution: 1 };

  assert.deepEqual(randomizer.selectRepositories(repos, cfg, store, { dryRun: true }).map(r => r.id), ['b']);
  assert.deepEqual(randomizer.selectRepositories(repos, cfg, store, { dryRun: true }).map(r => r.id), ['b']);
  assert.equal(store.index, 1);
  assert.deepEqual(randomizer.selectRepositories(repos, cfg, store).map(r => r.id), ['b']);
  assert.equal(store.index, 2);
});

test('selectRepositories round-robin wraps a stale cursor and skips disabled repos', () => {
  const repos = [
    { id: 'a', enabled: true },
    { id: 'x', enabled: false },
    { id: 'b', enabled: true }
  ];
  const store = memoryCursorStore(7);
  const selected = randomizer.selectRepositories(repos, { strategy: 'round-robin', maxPerExecution: 1 }, store);
  assert.deepEqual(selected.map(r => r.id), ['b']);
  assert.equal(store.index, 0);
});
