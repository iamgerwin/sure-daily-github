import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import config from '../src/config/loader.js';
import randomizer from '../src/utils/randomizer.js';

process.env.GITHUB_TOKEN = process.env.GITHUB_TOKEN || 'ghp_test';

const CONFIG_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../config');
const EXAMPLES = ['config.example.yaml', 'config.test-randomization.yaml'];

const readExample = (name) => yaml.load(fs.readFileSync(path.join(CONFIG_DIR, name), 'utf8'));

// The shipped examples are copied as starting points; a validation rule
// tightened without updating them would hand users a config that fails at once
for (const name of EXAMPLES) {
  test(`config/${name} passes config validation`, () => {
    const cfg = config.validate(readExample(name));
    assert.ok(cfg.repositories.length > 0);
  });
}

function withSeededRandom(fn) {
  let seed = 4242;
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

test('config/config.test-randomization.yaml weight comments match weighted selection odds', () => {
  const raw = readExample('config.test-randomization.yaml');
  const cfg = config.validate(raw);
  assert.equal(cfg.repositorySelection.strategy, 'weighted');
  assert.equal(cfg.repositorySelection.maxPerExecution, 2);

  // Comments state each weight as the first-pick chance and the overall
  // selection rates as roughly 75% / 70% / 55%
  const repos = cfg.repositories;
  assert.deepEqual(repos.map(r => r.weight), [40, 35, 25]);
  const runs = 20000;
  const first = repos.map(() => 0);
  const selected = repos.map(() => 0);

  withSeededRandom(() => {
    for (let i = 0; i < runs; i++) {
      const picks = randomizer.selectRepositories(repos, cfg.repositorySelection);
      assert.equal(picks.length, 2);
      first[repos.indexOf(picks[0])]++;
      picks.forEach(repo => { selected[repos.indexOf(repo)]++; });
    }
  });

  const near = (count, expected) => Math.abs(count / runs - expected) < 0.02;
  [0.40, 0.35, 0.25].forEach((expected, i) => assert.ok(near(first[i], expected), JSON.stringify(first)));
  [0.75, 0.70, 0.55].forEach((expected, i) => assert.ok(near(selected[i], expected), JSON.stringify(selected)));
});
