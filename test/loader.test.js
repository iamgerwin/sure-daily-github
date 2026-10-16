import test from 'node:test';
import assert from 'node:assert/strict';
import config from '../src/config/loader.js';

process.env.GITHUB_TOKEN = 'ghp_test';

const baseRepo = { owner: 'me', repo: 'demo' };

test('validate preserves per-repo intervalMinutes', () => {
  const cfg = config.validate({
    repositories: [{ ...baseRepo, intervalMinutes: { min: 60, max: 180 } }]
  });
  assert.deepEqual(cfg.repositories[0].intervalMinutes, { min: 60, max: 180 });
});

test('validate defaults intervalMinutes to null when not configured', () => {
  const cfg = config.validate({ repositories: [baseRepo] });
  assert.equal(cfg.repositories[0].intervalMinutes, null);
});

test('validate preserves contentTemplates', () => {
  const templates = [{ title: 'Bug: ${randomBugTitle}', body: 'b', labels: ['bug'] }];
  const cfg = config.validate({ repositories: [baseRepo], contentTemplates: templates });
  assert.deepEqual(cfg.contentTemplates, templates);
});

test('validate defaults contentTemplates to an empty array', () => {
  const cfg = config.validate({ repositories: [baseRepo] });
  assert.deepEqual(cfg.contentTemplates, []);
});

test('validate rejects invalid intervalMinutes', () => {
  assert.throws(
    () => config.validate({ repositories: [{ ...baseRepo, intervalMinutes: { min: 90, max: 30 } }] }),
    /intervalMinutes min cannot be greater than max/
  );
  assert.throws(
    () => config.validate({ repositories: [{ ...baseRepo, intervalMinutes: { min: 0, max: 30 } }] }),
    /intervalMinutes must have positive numeric min and max/
  );
});

test('validate rejects non-array contentTemplates', () => {
  assert.throws(
    () => config.validate({ repositories: [baseRepo], contentTemplates: { title: 'x' } }),
    /contentTemplates must be an array/
  );
});

test('validate rejects an unknown general.mode instead of falling back to commit mode', () => {
  assert.throws(
    () => config.validate({ repositories: [baseRepo], general: { mode: 'issues' } }),
    /general\.mode must be one of: commit, issue/
  );
});

test('validate accepts commit and issue modes and defaults to commit', () => {
  assert.equal(config.validate({ repositories: [baseRepo], general: { mode: 'issue' } }).general.mode, 'issue');
  assert.equal(config.validate({ repositories: [baseRepo], general: { mode: 'commit' } }).general.mode, 'commit');
  assert.equal(config.validate({ repositories: [baseRepo] }).general.mode, 'commit');
});

test('validate rejects invalid general and schedule timezones', () => {
  assert.throws(
    () => config.validate({ repositories: [baseRepo], general: { timezone: 'Asia/Manilla' } }),
    /general\.timezone is not a valid IANA timezone: Asia\/Manilla/
  );
  assert.throws(
    () => config.validate({ repositories: [baseRepo], schedule: { enabled: true, cron: '0 9 * * *', timezone: 'Mars/Base' } }),
    /schedule\.timezone is not a valid IANA timezone: Mars\/Base/
  );
  assert.throws(
    () => config.validate({ repositories: [baseRepo], general: { timezone: 8 } }),
    /general\.timezone is not a valid IANA timezone/
  );
});

test('validate accepts valid timezones and defaults general.timezone to UTC', () => {
  const cfg = config.validate({
    repositories: [baseRepo],
    general: { timezone: 'Asia/Manila' },
    schedule: { enabled: true, cron: '0 9 * * *', timezone: 'America/New_York' }
  });
  assert.equal(cfg.general.timezone, 'Asia/Manila');
  assert.equal(cfg.schedule.timezone, 'America/New_York');
  assert.equal(config.validate({ repositories: [baseRepo] }).general.timezone, 'UTC');
});

test('validate rejects an inverted per-repo dailyTarget range instead of crashing at run time', () => {
  assert.throws(
    () => config.validate({ repositories: [{ ...baseRepo, dailyTarget: { min: 5, max: 2 } }] }),
    /Repository 0: dailyTarget min cannot be greater than max/
  );
});

test('validate rejects incomplete or malformed per-repo dailyTarget values', () => {
  assert.throws(
    () => config.validate({ repositories: [{ ...baseRepo, dailyTarget: { min: 3 } }] }),
    /Repository 0: dailyTarget range must have min and max values/
  );
  assert.throws(
    () => config.validate({ repositories: [{ ...baseRepo, dailyTarget: { min: 1, max: 2.5 } }] }),
    /Repository 0: dailyTarget range must be whole numbers between 1 and 100/
  );
  assert.throws(
    () => config.validate({ repositories: [{ ...baseRepo, dailyTarget: 0 }] }),
    /Repository 0: dailyTarget must be a whole number between 1 and 100/
  );
  assert.throws(
    () => config.validate({ repositories: [{ ...baseRepo, dailyTarget: '3' }] }),
    /Repository 0: dailyTarget must be a number or a \{ min, max \} range/
  );
});

test('validate applies the same dailyTarget rules to general settings', () => {
  assert.throws(
    () => config.validate({ repositories: [baseRepo], general: { dailyTarget: { min: 0, max: 3 } } }),
    /dailyTarget range must be whole numbers between 1 and 100/
  );
  assert.throws(
    () => config.validate({ repositories: [baseRepo], general: { dailyTarget: 101 } }),
    /dailyTarget must be a whole number between 1 and 100/
  );
});

test('validate accepts and normalizes valid per-repo dailyTarget values', () => {
  const cfg = config.validate({
    repositories: [
      { ...baseRepo, dailyTarget: 4 },
      { ...baseRepo, repo: 'ranged', dailyTarget: { min: 2, max: 6 } },
      { ...baseRepo, repo: 'inherits' }
    ],
    general: { dailyTarget: { min: 1, max: 3 } }
  });
  assert.deepEqual(cfg.repositories.map(r => r.dailyTarget), [
    { min: 4, max: 4 },
    { min: 2, max: 6 },
    { min: 1, max: 3 }
  ]);
});

test('validate rejects a non-positive or fractional maxPerExecution', () => {
  for (const maxPerExecution of [0, -1, 1.5, '2']) {
    assert.throws(
      () => config.validate({ repositories: [baseRepo], repositorySelection: { strategy: 'random', maxPerExecution } }),
      /repositorySelection.maxPerExecution must be a positive whole number or null/,
      `maxPerExecution ${JSON.stringify(maxPerExecution)} should be rejected`
    );
  }
});

test('validate accepts a positive or null maxPerExecution', () => {
  for (const maxPerExecution of [1, 3, null, undefined]) {
    const cfg = config.validate({ repositories: [baseRepo], repositorySelection: { strategy: 'random', maxPerExecution } });
    assert.equal(cfg.repositorySelection.maxPerExecution, maxPerExecution);
  }
});

test('validate rejects a non-positive or non-numeric repository weight', () => {
  for (const weight of [0, -5, '10', Infinity]) {
    assert.throws(
      () => config.validate({ repositories: [{ ...baseRepo, weight }] }),
      /Repository 0: weight must be a positive number/,
      `weight ${String(weight)} should be rejected`
    );
  }
});

test('validate keeps positive weights and defaults a missing weight to 1', () => {
  const cfg = config.validate({ repositories: [{ ...baseRepo, weight: 2.5 }, { owner: 'me', repo: 'other' }] });
  assert.equal(cfg.repositories[0].weight, 2.5);
  assert.equal(cfg.repositories[1].weight, 1);
});
