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

const repoConfig = (repo) => ({
  owner: 'me',
  repo,
  enabled: true,
  dailyTarget: { min: 3, max: 3 }
});

function createHandler({ fail = false } = {}) {
  const handler = new IssueHandler('ghp_test');
  const calls = [];
  handler.delay = async () => {};
  handler.client = {
    octokit: {
      rest: {
        issues: {
          create: async (params) => {
            calls.push(params);
            if (fail) throw new Error('boom');
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
  assert.equal(results[0].skippedCount, 1);
  assert.deepEqual(summarize(results), { successful: 0, skipped: 1, failed: 0 });
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
