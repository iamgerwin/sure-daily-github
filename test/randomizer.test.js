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

test('weighted selection preserves odds when finite weights would overflow their sum', () => {
  const repos = [
    { id: 'A', enabled: true, weight: 1e308 },
    { id: 'B', enabled: true, weight: 5e307 },
    { id: 'C', enabled: true, weight: 5e307 }
  ];
  const originalRandom = Math.random;
  try {
    for (const [draw, expected] of [[0, 'A'], [0.25, 'A'], [0.6, 'B'], [0.9, 'C']]) {
      Math.random = () => draw;
      const selected = randomizer.selectRepositories(repos, { strategy: 'weighted', maxPerExecution: 1 });
      assert.deepEqual(selected.map(repo => repo.id), [expected], `draw ${draw}`);
    }
  } finally {
    Math.random = originalRandom;
  }
});

test('weighted selection handles subnormal weights and zero draws without selecting an underflowed weight', () => {
  const originalRandom = Math.random;
  try {
    Math.random = () => 0.75;
    const tiny = [
      { id: 'A', enabled: true, weight: Number.MIN_VALUE },
      { id: 'B', enabled: true, weight: Number.MIN_VALUE }
    ];
    assert.deepEqual(randomizer.selectWeightedRepositories(tiny, 1), [tiny[1]]);

    Math.random = () => 0;
    const mixed = [tiny[0], { id: 'large', enabled: true, weight: Number.MAX_VALUE }];
    assert.deepEqual(randomizer.selectWeightedRepositories(mixed, 1), [mixed[1]]);
  } finally {
    Math.random = originalRandom;
  }
});

test('weighted selection rescales the remaining pool after a large weight is removed', () => {
  const repos = [
    { id: 'large', enabled: true, weight: Number.MAX_VALUE },
    { id: 'small', enabled: true, weight: Number.MIN_VALUE },
    { id: 'default', enabled: true }
  ];
  const originalRandom = Math.random;
  Math.random = () => 0.5;
  try {
    const selected = randomizer.selectRepositories(repos, { strategy: 'weighted' });
    assert.deepEqual(selected.map(repo => repo.id), ['large', 'default', 'small']);
    assert.deepEqual(repos.map(repo => repo.id), ['large', 'small', 'default']);
  } finally {
    Math.random = originalRandom;
  }
});

// Seeded mulberry32 generator so the frequency check below can never flake
function withSeededRandom(fn) {
  let seed = 12345;
  const originalRandom = Math.random;
  Math.random = () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  try {
    return fn();
  } finally {
    Math.random = originalRandom;
  }
}

test('selectRepositories weighted selection odds match docs/RANDOMIZATION.md', () => {
  // A weight is the chance of the first pick; with 2 of 3 drawn without
  // replacement the documented selection rates are ~84%, ~68% and ~49%
  const repos = [
    { id: 'high', enabled: true, weight: 50 },
    { id: 'medium', enabled: true, weight: 30 },
    { id: 'low', enabled: true, weight: 20 }
  ];
  const runs = 20000;
  const selected = { high: 0, medium: 0, low: 0 };
  const first = { high: 0, medium: 0, low: 0 };

  withSeededRandom(() => {
    for (let i = 0; i < runs; i++) {
      const picks = randomizer.selectRepositories(repos, { strategy: 'weighted', maxPerExecution: 2 });
      assert.equal(new Set(picks).size, 2);
      first[picks[0].id]++;
      picks.forEach(repo => { selected[repo.id]++; });
    }
  });

  const near = (count, expected) => Math.abs(count / runs - expected) < 0.02;
  assert.ok(near(first.high, 0.5) && near(first.medium, 0.3) && near(first.low, 0.2), JSON.stringify(first));
  assert.ok(near(selected.high, 0.839), JSON.stringify(selected));
  assert.ok(near(selected.medium, 0.675), JSON.stringify(selected));
  assert.ok(near(selected.low, 0.486), JSON.stringify(selected));
});

test('selectRepositories weighted without maxPerExecution selects every repository', () => {
  const repos = [
    { id: 'A', enabled: true, weight: 50 },
    { id: 'B', enabled: true, weight: 30 },
    { id: 'C', enabled: true }
  ];

  withSeededRandom(() => {
    for (let i = 0; i < 50; i++) {
      const selected = randomizer.selectRepositories(repos, { strategy: 'weighted' });
      assert.deepEqual(selected.map(repo => repo.id).sort(), ['A', 'B', 'C']);
    }
  });
});

test('selectRepositories round-robin ignores randomizeOrder', () => {
  const repos = ['a', 'b', 'c', 'd'].map(id => ({ id, enabled: true }));
  let index = 1;
  const cursor = { getRoundRobinIndex: () => index, setRoundRobinIndex: (next) => { index = next; } };

  withSeededRandom(() => {
    const selected = randomizer.selectRepositories(repos, { strategy: 'round-robin', randomizeOrder: true }, cursor);
    assert.deepEqual(selected.map(repo => repo.id), ['b', 'c', 'd', 'a']);
  });
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

test('selectRepositories round-robin does not skip a repository when an earlier one drops out', () => {
  const rotation = ['a', 'b', 'c'].map(id => ({ id, enabled: true }));
  const [a, b, c] = rotation;
  const store = memoryCursorStore();
  const cfg = { strategy: 'round-robin', maxPerExecution: 1 };

  assert.deepEqual(randomizer.selectRepositories([a, b, c], cfg, store, { rotation }).map(r => r.id), ['a']);
  // a met its target, so only b and c are candidates; b is next, not c
  assert.deepEqual(randomizer.selectRepositories([b, c], cfg, store, { rotation }).map(r => r.id), ['b']);
  assert.deepEqual(randomizer.selectRepositories([b, c], cfg, store, { rotation }).map(r => r.id), ['c']);
  assert.deepEqual(randomizer.selectRepositories([a, b, c], cfg, store, { rotation }).map(r => r.id), ['a']);
});

test('selectRepositories round-robin passes over a waiting repository and resumes after the pick', () => {
  const rotation = ['a', 'b', 'c', 'd'].map(id => ({ id, enabled: true }));
  const [a, , c, d] = rotation;
  const store = memoryCursorStore(1);
  const cfg = { strategy: 'round-robin', maxPerExecution: 2 };

  // b is waiting, so the picks after the cursor are c and d; the next run starts at a
  assert.deepEqual(randomizer.selectRepositories([a, c, d], cfg, store, { rotation }).map(r => r.id), ['c', 'd']);
  assert.equal(store.index, 0);
});

test('selectRepositories round-robin ignores disabled repositories in the rotation', () => {
  const rotation = [
    { id: 'a', enabled: true },
    { id: 'x', enabled: false },
    { id: 'b', enabled: true }
  ];
  const store = memoryCursorStore(1);
  const selected = randomizer.selectRepositories(rotation, { strategy: 'round-robin', maxPerExecution: 1 }, store, { rotation });
  assert.deepEqual(selected.map(r => r.id), ['b']);
  assert.equal(store.index, 0);
});
