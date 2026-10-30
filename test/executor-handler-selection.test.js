import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Isolate state and run lock before the executor imports them
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-selection-'));
process.env.SDG_STATE_FILE = path.join(stateDir, 'state.json');
process.env.SDG_ISSUE_STATE_FILE = path.join(stateDir, 'issue-state.json');
process.env.GITHUB_TOKEN = 'ghp_test';

const { default: executor, usesAdvancedIssueHandler, randomizationCountsIgnoredReason } = await import('../src/core/executor.js');
const { default: config } = await import('../src/config/loader.js');
const { default: IssueHandler } = await import('../src/github/issue-handler.js');
const { default: AdvancedIssueHandler } = await import('../src/github/advanced-issue-handler.js');

const issueConfig = (repo) => config.validate({
  general: { mode: 'issue', dailyTarget: 1 },
  repositories: [{ owner: 'me', repo: 'demo', ...repo }]
});

test('a fixed dailyTarget uses the simple handler after loader normalization', () => {
  const cfg = issueConfig({ dailyTarget: 3 });
  assert.deepEqual(cfg.repositories[0].dailyTarget, { min: 3, max: 3 });
  assert.equal(usesAdvancedIssueHandler(cfg.repositories), false);
  assert.equal(usesAdvancedIssueHandler(issueConfig({}).repositories), false);
});

test('a dailyTarget range or intervalMinutes uses the advanced handler', () => {
  assert.equal(usesAdvancedIssueHandler(issueConfig({ dailyTarget: { min: 2, max: 5 } }).repositories), true);
  assert.equal(usesAdvancedIssueHandler(issueConfig({ intervalMinutes: { min: 30, max: 60 } }).repositories), true);
});

test('raw, un-normalized configs are still classified correctly', () => {
  assert.equal(usesAdvancedIssueHandler([{ dailyTarget: 2 }]), false);
  assert.equal(usesAdvancedIssueHandler([{ dailyTarget: { min: 1, max: 4 } }]), true);
  assert.equal(usesAdvancedIssueHandler([]), false);
});

test('a disabled repository with a range or interval does not select the advanced handler', () => {
  const cfg = config.validate({
    general: { mode: 'issue', dailyTarget: 1 },
    repositories: [
      { owner: 'me', repo: 'live', dailyTarget: 2 },
      { owner: 'me', repo: 'ranged', enabled: false, dailyTarget: { min: 1, max: 4 } },
      { owner: 'me', repo: 'spaced', enabled: false, intervalMinutes: { min: 30, max: 60 } }
    ]
  });
  assert.equal(usesAdvancedIssueHandler(cfg.repositories), false);

  cfg.repositories[1].enabled = true;
  assert.equal(usesAdvancedIssueHandler(cfg.repositories), true);
  assert.equal(usesAdvancedIssueHandler([{ enabled: false, dailyTarget: { min: 1, max: 4 } }]), false);
});

test('randomization counts are reported unused outside simple issue mode', () => {
  const randomized = (general, repo) => config.validate({
    general: { mode: 'issue', dailyTarget: 1, ...general },
    randomization: { enabled: true, issueCount: { min: 2, max: 4 } },
    repositories: [{ owner: 'me', repo: 'demo', ...repo }]
  });

  assert.equal(randomizationCountsIgnoredReason(randomized({}, { dailyTarget: 3 })), null);
  assert.match(randomizationCountsIgnoredReason(randomized({ mode: 'commit' }, {})), /commit mode/);
  assert.match(randomizationCountsIgnoredReason(randomized({}, { dailyTarget: { min: 2, max: 5 } })), /advanced issue handler/);
  assert.match(randomizationCountsIgnoredReason(randomized({}, { intervalMinutes: { min: 30, max: 60 } })), /advanced issue handler/);

  const disabled = randomized({ mode: 'commit' }, {});
  disabled.randomization.enabled = false;
  assert.equal(randomizationCountsIgnoredReason(disabled), null);
  assert.equal(randomizationCountsIgnoredReason(issueConfig({})), null);
});

test('execute routes a loaded fixed-target issue config to IssueHandler', async (t) => {
  const calls = [];
  const stub = (Handler) => {
    const init = mock.method(Handler.prototype, 'init', async () => ({ success: true, user: 'me' }));
    const process = mock.method(Handler.prototype, 'processRepositories', async () => {
      calls.push(Handler.name);
      return [];
    });
    t.after(() => { init.mock.restore(); process.mock.restore(); });
  };
  stub(IssueHandler);
  stub(AdvancedIssueHandler);

  const fixed = await executor.execute(issueConfig({ dailyTarget: 2 }));
  assert.equal(fixed.success, true);
  const ranged = await executor.execute(issueConfig({ dailyTarget: { min: 1, max: 3 } }));
  assert.equal(ranged.success, true);

  assert.deepEqual(calls, ['IssueHandler', 'AdvancedIssueHandler']);
});
