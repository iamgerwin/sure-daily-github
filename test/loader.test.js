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

test('validate leaves branch unset so the repository default branch is used', () => {
  const cfg = config.validate({ repositories: [baseRepo, { ...baseRepo, repo: 'other', branch: 'develop' }] });
  assert.equal(cfg.repositories[0].branch, null);
  assert.equal(cfg.repositories[1].branch, 'develop');
});
