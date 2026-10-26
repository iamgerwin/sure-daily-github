import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Point the shared StateManager at a temp file before the handler imports it
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-issue-'));
process.env.SDG_STATE_FILE = path.join(stateDir, 'state.json');

const { default: IssueHandler } = await import('../src/github/issue-handler.js');
const { default: state } = await import('../src/utils/state.js');
const { describeFailures, getRunExitCode } = await import('../src/core/executor.js');

const repoConfig = (repo) => ({
  owner: 'me',
  repo,
  enabled: true,
  dailyTarget: { min: 3, max: 3 }
});

function createHandler({ fail = false, failFrom = Infinity } = {}) {
  const handler = new IssueHandler('ghp_test');
  const calls = [];
  handler.delay = async () => {};
  handler.client = {
    octokit: {
      rest: {
        issues: {
          create: async (params) => {
            calls.push(params);
            if (fail || calls.length >= failFrom) throw new Error('boom');
            return { data: { number: calls.length, html_url: `https://x/${calls.length}`, title: params.title } };
          }
        }
      }
    }
  };
  return { handler, calls };
}

// Mirrors the summary computed by Executor.run
function summarize(results) {
  return {
    successful: results.filter(r => r.success && !r.skipped).length,
    skipped: results.filter(r => r.skipped).length,
    failed: results.filter(r => !r.success).length
  };
}

test('repo already at its daily limit is reported as skipped, not failed', async () => {
  for (let i = 0; i < 3; i++) state.recordAction('me', 'full');
  const { handler, calls } = createHandler();

  const results = await handler.processRepositories([repoConfig('full')], {}, false, {});

  assert.equal(calls.length, 0);
  assert.equal(results[0].success, true);
  assert.equal(results[0].skipped, true);
  assert.equal(results[0].reason, 'limit_reached');
  assert.deepEqual(summarize(results), { successful: 0, skipped: 1, failed: 0 });
});

test('maxPerExecution slot goes to a repo still within its limits', async () => {
  for (let i = 0; i < 3; i++) state.recordAction('me', 'done-first');
  const { handler, calls } = createHandler();
  const config = { repositorySelection: { strategy: 'sequential', maxPerExecution: 1 } };

  const results = await handler.processRepositories(
    [repoConfig('done-first'), repoConfig('open-second'), repoConfig('open-third')], {}, false, config
  );

  assert.equal(calls.length, 3);
  assert.ok(calls.every(c => c.repo === 'open-second'));
  const byRepo = Object.fromEntries(results.map(r => [r.repo, r]));
  assert.equal(byRepo['done-first'].reason, 'limit_reached');
  assert.equal(byRepo['open-second'].successful, 3);
  assert.equal(byRepo['open-third'].reason, 'not_selected');
  assert.deepEqual(summarize(results), { successful: 1, skipped: 2, failed: 0 });
});

test('disabled repos are neither selected nor reported as limit reached', async () => {
  const { handler, calls } = createHandler();

  const results = await handler.processRepositories([{ ...repoConfig('off'), enabled: false }], {}, false, {});

  assert.equal(calls.length, 0);
  assert.deepEqual(results, []);
});

test('partial run that hits the limit counts as successful only', async () => {
  state.recordAction('me', 'partial');
  const { handler, calls } = createHandler();

  const results = await handler.processRepositories([repoConfig('partial')], {}, false, {});

  assert.equal(calls.length, 2);
  assert.equal(results[0].successful, 2);
  assert.equal(results[0].skippedCount, 1);
  assert.equal(results[0].skipped, false);
  assert.deepEqual(summarize(results), { successful: 1, skipped: 0, failed: 0 });
});

test('run where issue creation fails is reported as failed', async () => {
  const { handler } = createHandler({ fail: true });

  const results = await handler.processRepositories([repoConfig('broken')], {}, false, {});

  assert.equal(results[0].success, false);
  assert.equal(results[0].skipped, false);
  assert.equal(results[0].failed, 1);
  assert.deepEqual(summarize(results), { successful: 0, skipped: 0, failed: 1 });
});

test('run where a later issue fails after earlier ones succeed is reported as failed', async () => {
  const { handler, calls } = createHandler({ failFrom: 2 });

  const results = await handler.processRepositories([repoConfig('half-broken')], {}, false, {});

  assert.equal(calls.length, 2);
  assert.equal(results[0].success, false);
  assert.equal(results[0].skipped, false);
  assert.equal(results[0].successful, 1);
  assert.equal(results[0].failed, 1);
  assert.deepEqual(summarize(results), { successful: 0, skipped: 0, failed: 1 });
  assert.deepEqual(describeFailures(results), ['me/half-broken: boom']);
  assert.equal(getRunExitCode({ success: true, summary: summarize(results) }), 1);
});

test('generateIssueContent renders date and time in the configured timezone', () => {
  const { handler } = createHandler();
  const now = new Date('2026-10-14T23:30:05Z');

  const content = handler.generateIssueContent({ title: 'Update ${date}', body: '${time} ${timestamp}' }, 'Asia/Manila', now);

  assert.deepEqual(content, { title: 'Update 2026-10-15', body: '07:30:05 2026-10-14T23:30:05.000Z' });
});

test('createDailyIssue passes the configured timezone to issue templates', async () => {
  const { handler, calls } = createHandler();
  const timezone = 'Pacific/Kiritimati';
  const localDate = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date());

  await handler.createDailyIssue(repoConfig('tz'), { title: '${date}' }, false, null, { general: { timezone } });

  assert.equal(calls[0].title, localDate);
});

test('rate-limit delays only separate real API calls, never trail the last repo', async () => {
  const { handler, calls } = createHandler();
  const delays = [];
  handler.delay = async (ms) => { delays.push(ms); };

  await handler.processRepositories([repoConfig('pace-a'), repoConfig('pace-b')], {}, false, {});

  assert.equal(calls.length, 6);
  assert.deepEqual(delays, [2000, 2000, 1000, 2000, 2000]);
});

test('dry runs and limit-reached repos do not wait on rate-limit delays', async () => {
  for (let i = 0; i < 3; i++) state.recordAction('me', 'pace-full');
  const { handler, calls } = createHandler();
  const delays = [];
  handler.delay = async (ms) => { delays.push(ms); };

  await handler.processRepositories([repoConfig('pace-dry-a'), repoConfig('pace-dry-b')], {}, true, {});
  await handler.processRepositories([repoConfig('pace-full')], {}, false, {});

  assert.equal(calls.length, 0);
  assert.deepEqual(delays, []);
});

const fixedRepo = (repo) => ({ ...repoConfig(repo), dailyTarget: { min: 1, max: 1 } });

test('enabled randomization issueCount replaces the repository dailyTarget as the daily cap', async () => {
  const { handler, calls } = createHandler();
  const config = { randomization: { enabled: true, issueCount: { min: 3, max: 3 } } };

  const results = await handler.processRepositories([fixedRepo('rand-count')], {}, false, config);

  assert.equal(calls.length, 3);
  assert.equal(results[0].successful, 3);
  assert.equal(results[0].skippedCount, 0);
  assert.equal(handler.checkLimits(fixedRepo('rand-count'), config).allowed, false);
});

test('timeVariations.daily max is the daily cap when time variations are enabled', async () => {
  const { handler, calls } = createHandler();
  const config = {
    randomization: {
      enabled: true,
      issueCount: { min: 1, max: 1 },
      timeVariations: { enabled: true, daily: { min: 2, max: 2 } }
    }
  };

  const results = await handler.processRepositories([fixedRepo('rand-daily')], {}, false, config);

  assert.equal(calls.length, 2);
  assert.equal(results[0].successful, 2);
  assert.equal(handler.checkLimits(fixedRepo('rand-daily'), config).limits.dailyMax, 2);
});

test('disabled randomization keeps the repository dailyTarget as the daily cap', () => {
  const { handler } = createHandler();
  const config = { randomization: { enabled: false, issueCount: { min: 5, max: 5 } } };

  assert.equal(handler.checkLimits(fixedRepo('rand-off'), config).limits.dailyMax, 1);
});
