import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import AdvancedIssueHandler from '../src/github/advanced-issue-handler.js';
import { describeFailures } from '../src/core/executor.js';
import loader, { DEFAULT_CONTENT_TEMPLATE } from '../src/config/loader.js';

const config = { general: { timezone: 'UTC' }, randomization: {}, contentTemplates: [] };

function repo(overrides = {}) {
  return {
    owner: 'me',
    repo: 'demo',
    enabled: true,
    dailyTarget: { min: 3, max: 3 },
    intervalMinutes: null,
    labels: ['automated'],
    ...overrides
  };
}

// State file inside a directory that does not exist yet (fresh install)
function createHandler() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-issue-'));
  process.env.SDG_ISSUE_STATE_FILE = path.join(dir, 'data', 'issue-state.json');
  const handler = new AdvancedIssueHandler('ghp_test');
  delete process.env.SDG_ISSUE_STATE_FILE;
  handler.delay = async () => {};

  const created = [];
  handler.client = {
    issues: {
      create: async (params) => {
        created.push(params);
        return { data: { number: created.length, html_url: 'https://example.test', title: params.title } };
      }
    }
  };
  return { handler, created };
}

function readState(handler) {
  return JSON.parse(fs.readFileSync(handler.stateFile, 'utf8'));
}

test('persists state when the data directory does not exist yet', async () => {
  const { handler, created } = createHandler();

  await handler.processRepositories([repo()], {}, false, config);
  await handler.processRepositories([repo()], {}, false, config);

  assert.equal(created.length, 2);
  assert.equal(readState(handler).repositories['me/demo'].issuesCreatedToday, 2);
});

test('stops at the daily target across runs', async () => {
  const { handler, created } = createHandler();

  for (let i = 0; i < 5; i++) {
    await handler.processRepositories([repo()], {}, false, config);
  }

  assert.equal(created.length, 3);
});

test('re-rolls today\'s target when the dailyTarget range changes mid-day', async () => {
  const { handler, created } = createHandler();

  for (let i = 0; i < 2; i++) {
    await handler.processRepositories([repo({ dailyTarget: { min: 5, max: 5 } })], {}, false, config);
  }
  assert.equal(readState(handler).repositories['me/demo'].todayTarget, 5);

  // Lowering the range applies today: 2 issues already exist, so nothing more is created
  for (let i = 0; i < 3; i++) {
    await handler.processRepositories([repo({ dailyTarget: { min: 1, max: 2 } })], {}, false, config);
  }

  const saved = readState(handler).repositories['me/demo'];
  assert.equal(created.length, 2);
  assert.ok(saved.todayTarget >= 1 && saved.todayTarget <= 2);
  assert.deepEqual(saved.targetRange, { min: 1, max: 2 });
  assert.equal(saved.issuesCreatedToday, 2);
});

test('keeps today\'s rolled target across runs while the range is unchanged', async () => {
  const { handler } = createHandler();
  const ranged = repo({ dailyTarget: { min: 1, max: 1000 } });

  await handler.processRepositories([ranged], {}, false, config);
  const first = readState(handler).repositories['me/demo'].todayTarget;
  await handler.processRepositories([ranged], {}, false, config);

  assert.equal(readState(handler).repositories['me/demo'].todayTarget, first);
});

test('state without a recorded range keeps a target that fits the configured range', async () => {
  const { handler, created } = createHandler();
  writeState(handler, {
    lastDailyReset: new Date().toISOString(),
    repositories: {
      'me/demo': { issuesCreatedToday: 4, lastIssueTime: null, todayTarget: 4, nextIssueTime: null }
    }
  });

  await handler.processRepositories([repo({ dailyTarget: { min: 2, max: 6 } })], {}, false, config);

  const saved = readState(handler).repositories['me/demo'];
  assert.equal(created.length, 0);
  assert.equal(saved.todayTarget, 4);
  assert.deepEqual(saved.targetRange, { min: 2, max: 6 });
});

test('state without a recorded range re-rolls a target outside the configured range', async () => {
  const { handler, created } = createHandler();
  writeState(handler, {
    lastDailyReset: new Date().toISOString(),
    repositories: {
      'me/demo': { issuesCreatedToday: 0, lastIssueTime: null, todayTarget: 9, nextIssueTime: null }
    }
  });

  await handler.processRepositories([repo({ dailyTarget: { min: 1, max: 1 } })], {}, false, config);

  assert.equal(created.length, 1);
  assert.equal(readState(handler).repositories['me/demo'].todayTarget, 1);
});

test('dry run does not write to the state file', async () => {
  const { handler, created } = createHandler();

  await handler.processRepositories([repo()], {}, true, config);

  assert.equal(created.length, 0);
  assert.equal(fs.existsSync(handler.stateFile), false);
});

test('repositories with the same name under different owners are tracked separately', async () => {
  const { handler } = createHandler();

  await handler.processRepositories([repo({ owner: 'alice' }), repo({ owner: 'bob' })], {}, false, config);

  const { repositories } = readState(handler);
  assert.equal(repositories['alice/demo'].issuesCreatedToday, 1);
  assert.equal(repositories['bob/demo'].issuesCreatedToday, 1);
});

test('migrates legacy repo-name keys without losing progress', async () => {
  const { handler, created } = createHandler();
  fs.mkdirSync(path.dirname(handler.stateFile), { recursive: true });
  fs.writeFileSync(handler.stateFile, JSON.stringify({
    lastDailyReset: new Date().toISOString(),
    repositories: {
      demo: { issuesCreatedToday: 3, lastIssueTime: null, todayTarget: 3, nextIssueTime: null }
    }
  }));

  await handler.processRepositories([repo()], {}, false, config);

  const { repositories } = readState(handler);
  assert.equal(created.length, 0);
  assert.equal(repositories.demo, undefined);
  assert.equal(repositories['me/demo'].issuesCreatedToday, 3);
});

test('keeps today\'s progress when the configured repository name changes case', async () => {
  const { handler, created } = createHandler();
  fs.mkdirSync(path.dirname(handler.stateFile), { recursive: true });
  const next = Date.now() + 30 * 60 * 1000;
  fs.writeFileSync(handler.stateFile, JSON.stringify({
    lastDailyReset: new Date().toISOString(),
    repositories: {
      'Me/Demo': { issuesCreatedToday: 3, lastIssueTime: null, todayTarget: 3, targetRange: { min: 3, max: 3 }, nextIssueTime: next }
    }
  }));

  // status (read-only) already sees the entry under its old casing
  const { repositories: [status] } = await handler.getStatus([repo()], 'UTC');
  assert.equal(status.issuesCreatedToday, 3);
  assert.equal(status.nextIssueTime, new Date(next).toISOString());

  await handler.processRepositories([repo()], {}, false, config);

  const { repositories } = readState(handler);
  assert.equal(created.length, 0);
  assert.equal(repositories['Me/Demo'], undefined);
  assert.equal(repositories['me/demo'].issuesCreatedToday, 3);
  assert.equal(repositories['me/demo'].nextIssueTime, next);
});

test('an exact-case entry wins over a differently cased one', async () => {
  const { handler, created } = createHandler();
  fs.mkdirSync(path.dirname(handler.stateFile), { recursive: true });
  fs.writeFileSync(handler.stateFile, JSON.stringify({
    lastDailyReset: new Date().toISOString(),
    repositories: {
      'Me/Demo': { issuesCreatedToday: 3, lastIssueTime: null, todayTarget: 3, nextIssueTime: null },
      'me/demo': { issuesCreatedToday: 1, lastIssueTime: null, todayTarget: 3, nextIssueTime: null }
    }
  }));

  await handler.processRepositories([repo()], {}, false, config);

  const { repositories } = readState(handler);
  assert.equal(created.length, 1);
  assert.equal(repositories['me/demo'].issuesCreatedToday, 2);
  assert.equal(repositories['Me/Demo'].issuesCreatedToday, 3);
});

test('aborts the run when state cannot be persisted after creating an issue', async () => {
  const { handler, created } = createHandler();
  handler.saveState = async () => { throw new Error('disk full'); };

  await assert.rejects(
    handler.processRepositories([repo({ repo: 'one' }), repo({ repo: 'two' })], {}, false, config),
    /disk full/
  );
  assert.equal(created.length, 1);
});

test('backs up a corrupt state file instead of silently discarding it', async () => {
  const { handler } = createHandler();
  const dir = path.dirname(handler.stateFile);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(handler.stateFile, '{"repositories": {');

  const state = await handler.loadState();

  assert.deepEqual(state.repositories, {});
  assert.ok(fs.readdirSync(dir).some(f => f.startsWith('issue-state.json.corrupt-')));
});

function writeState(handler, state) {
  fs.mkdirSync(path.dirname(handler.stateFile), { recursive: true });
  fs.writeFileSync(handler.stateFile, JSON.stringify(state));
}

test('backs up a state file that is valid JSON but not an object', async () => {
  const { handler } = createHandler();
  writeState(handler, null);

  const state = await handler.loadState();

  assert.deepEqual(state.repositories, {});
  assert.ok(fs.readdirSync(path.dirname(handler.stateFile)).some(f => f.startsWith('issue-state.json.corrupt-')));
});

for (const [label, repositories] of [['an array', []], ['a string', 'oops'], ['a number', 7]]) {
  test(`stops at the daily target when the repositories section is ${label}`, async () => {
    const { handler, created } = createHandler();
    writeState(handler, { lastDailyReset: new Date().toISOString(), repositories });

    for (let i = 0; i < 5; i++) {
      await handler.processRepositories([repo()], {}, false, config);
    }

    assert.equal(created.length, 3);
    assert.equal(readState(handler).repositories['me/demo'].issuesCreatedToday, 3);
  });
}

for (const [label, entry] of [
  ['missing its count', { todayTarget: 3 }],
  ['with a non-numeric count', { issuesCreatedToday: 'two', todayTarget: 3 }],
  ['with a negative count', { issuesCreatedToday: -4, todayTarget: 3 }],
  ['that is not an object', 5]
]) {
  test(`stops at the daily target for a repository entry ${label}`, async () => {
    const { handler, created } = createHandler();
    writeState(handler, { lastDailyReset: new Date().toISOString(), repositories: { 'me/demo': entry } });

    for (let i = 0; i < 5; i++) {
      await handler.processRepositories([repo()], {}, false, config);
    }

    assert.equal(created.length, 3);
    assert.equal(readState(handler).repositories['me/demo'].issuesCreatedToday, 3);
  });
}

test('keeps a valid count from an existing entry', async () => {
  const { handler, created } = createHandler();
  writeState(handler, {
    lastDailyReset: new Date().toISOString(),
    repositories: { 'me/demo': { issuesCreatedToday: 2, todayTarget: 3 } }
  });

  for (let i = 0; i < 3; i++) {
    await handler.processRepositories([repo()], {}, false, config);
  }

  assert.equal(created.length, 1);
});

test('status reports today\'s progress when state is from the current day', async () => {
  const { handler } = createHandler();
  const next = Date.now() + 60 * 60 * 1000;
  writeState(handler, {
    lastDailyReset: new Date().toISOString(),
    repositories: {
      'me/demo': { issuesCreatedToday: 2, lastIssueTime: Date.now(), todayTarget: 3, nextIssueTime: next }
    }
  });

  const { timezone, repositories: [status] } = await handler.getStatus([repo()], 'UTC');

  assert.equal(timezone, 'UTC');
  assert.equal(status.issuesCreatedToday, 2);
  assert.equal(status.todayTarget, 3);
  assert.equal(status.nextIssueTime, new Date(next).toISOString());
});

test('status reports an elapsed issue interval as Any time, matching what the next run does', async () => {
  const { handler, created } = createHandler();
  const elapsed = Date.now() - 60 * 1000;
  writeState(handler, {
    lastDailyReset: new Date().toISOString(),
    repositories: {
      'me/demo': { issuesCreatedToday: 1, lastIssueTime: elapsed - 60 * 60 * 1000, todayTarget: 3, nextIssueTime: elapsed }
    }
  });

  const { repositories: [status] } = await handler.getStatus([repo()], 'UTC');
  assert.equal(status.nextIssueTime, 'Any time');

  // The next run does not wait for it either
  await handler.processRepositories([repo()], {}, false, config);
  assert.equal(created.length, 1);
});

test('status does not report a previous day\'s progress as today', async () => {
  const { handler } = createHandler();
  const yesterday = Date.now() - 36 * 60 * 60 * 1000;
  writeState(handler, {
    lastDailyReset: new Date(yesterday).toISOString(),
    repositories: {
      'me/demo': { issuesCreatedToday: 3, lastIssueTime: yesterday, todayTarget: 3, nextIssueTime: yesterday + 1000 }
    }
  });

  const { repositories: [status] } = await handler.getStatus([repo()], 'UTC');

  assert.equal(status.issuesCreatedToday, 0);
  assert.equal(status.todayTarget, 'Not set');
  assert.equal(status.nextIssueTime, 'Any time');
  // Last issue time is still accurate history
  assert.equal(status.lastIssueTime, new Date(yesterday).toISOString());
});

test('the daily reset keeps a pending interval from the previous day', async () => {
  const { handler, created } = createHandler();
  const yesterday = Date.now() - 36 * 60 * 60 * 1000;
  const next = Date.now() + 30 * 60 * 1000;
  writeState(handler, {
    lastDailyReset: new Date(yesterday).toISOString(),
    repositories: {
      'me/demo': { issuesCreatedToday: 3, lastIssueTime: yesterday, todayTarget: 3, targetRange: { min: 3, max: 3 }, nextIssueTime: next }
    }
  });

  const [result] = await handler.processRepositories([repo({ intervalMinutes: { min: 60, max: 60 } })], {}, false, config);

  assert.equal(created.length, 0);
  assert.match(result.reason, /Waiting for interval/);
  const saved = readState(handler).repositories['me/demo'];
  assert.equal(saved.issuesCreatedToday, 0);
  assert.equal(saved.todayTarget, 3);
  assert.equal(saved.lastIssueTime, yesterday);
  assert.equal(saved.nextIssueTime, next);
});

test('the daily reset clears counts so a new day starts from zero', async () => {
  const { handler, created } = createHandler();
  const yesterday = Date.now() - 36 * 60 * 60 * 1000;
  writeState(handler, {
    lastDailyReset: new Date(yesterday).toISOString(),
    repositories: {
      'me/demo': { issuesCreatedToday: 3, lastIssueTime: yesterday, todayTarget: 3, nextIssueTime: yesterday + 1000 },
      'me/gone': 5
    }
  });

  for (let i = 0; i < 5; i++) {
    await handler.processRepositories([repo()], {}, false, config);
  }

  assert.equal(created.length, 3);
  const { repositories } = readState(handler);
  assert.equal(repositories['me/demo'].issuesCreatedToday, 3);
  assert.deepEqual(repositories['me/gone'], { issuesCreatedToday: 0, lastIssueTime: null, todayTarget: null, nextIssueTime: null });
});

test('status reports a previous day\'s interval that has not elapsed yet', async () => {
  const { handler } = createHandler();
  const yesterday = Date.now() - 36 * 60 * 60 * 1000;
  const next = Date.now() + 30 * 60 * 1000;
  writeState(handler, {
    lastDailyReset: new Date(yesterday).toISOString(),
    repositories: {
      'me/demo': { issuesCreatedToday: 3, lastIssueTime: yesterday, todayTarget: 3, nextIssueTime: next }
    }
  });

  const { repositories: [status] } = await handler.getStatus([repo()], 'UTC');

  assert.equal(status.issuesCreatedToday, 0);
  assert.equal(status.nextIssueTime, new Date(next).toISOString());
});

test('status evaluates the day boundary in the configured timezone', async () => {
  const { handler } = createHandler();
  // 2026-01-01T23:30Z is already Jan 2 in Asia/Manila (UTC+8) but still Jan 1 in UTC
  const reset = new Date('2026-01-01T15:00:00Z');
  const now = new Date('2026-01-01T23:30:00Z');
  writeState(handler, {
    lastDailyReset: reset.toISOString(),
    repositories: {
      'me/demo': { issuesCreatedToday: 1, lastIssueTime: reset.getTime(), todayTarget: 3, nextIssueTime: null }
    }
  });

  const RealDate = global.Date;
  global.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [now.getTime()])); }
    static now() { return now.getTime(); }
  };
  try {
    const utc = await handler.getStatus([repo()], 'UTC');
    const manila = await handler.getStatus([repo()], 'Asia/Manila');
    assert.equal(utc.repositories[0].issuesCreatedToday, 1);
    assert.equal(manila.repositories[0].issuesCreatedToday, 0);
  } finally {
    global.Date = RealDate;
  }
});

test('honors repositorySelection.maxPerExecution', async () => {
  const { handler, created } = createHandler();
  const repos = ['a', 'b', 'c'].map(name => repo({ repo: name }));
  const cfg = { ...config, repositorySelection: { strategy: 'sequential', maxPerExecution: 1 } };

  const results = await handler.processRepositories(repos, {}, false, cfg);

  assert.deepEqual(created.map(c => c.repo), ['a']);
  const notSelected = results.filter(r => r.reason === 'Not selected this run').map(r => r.repo);
  assert.deepEqual(notSelected, ['b', 'c']);
});

test('failed results carry owner and repo so the CLI summary can name them', async () => {
  const { handler } = createHandler();
  handler.client.issues.create = async () => { throw new Error('Not Found'); };

  const results = await handler.processRepositories([repo({ repo: 'broken' })], {}, false, config);

  assert.equal(results.length, 1);
  assert.equal(results[0].success, false);
  assert.equal(results[0].owner, 'me');
  assert.equal(results[0].repo, 'broken');
  assert.deepEqual(describeFailures(results), ['me/broken: Not Found']);
});

test('skipped and created results carry owner and repo', async () => {
  const { handler } = createHandler();
  const repos = [repo({ repo: 'a' }), repo({ repo: 'b' }), repo({ repo: 'off', enabled: false })];
  const cfg = { ...config, repositorySelection: { strategy: 'sequential', maxPerExecution: 1 } };

  const results = await handler.processRepositories(repos, {}, false, cfg);

  for (const r of results) {
    assert.equal(r.owner, 'me');
    assert.ok(!r.repo.includes('/'), `repo should be the bare name, got ${r.repo}`);
  }
  assert.deepEqual(results.map(r => r.repo).sort(), ['a', 'b', 'off']);
});

test('round-robin rotates through repositories across runs', async () => {
  const { handler, created } = createHandler();
  const cursor = { index: 0 };
  handler.cursorStore = {
    getRoundRobinIndex: () => cursor.index,
    setRoundRobinIndex: (index) => { cursor.index = index; }
  };
  const repos = ['a', 'b', 'c'].map(name => repo({ repo: name }));
  const cfg = { ...config, repositorySelection: { strategy: 'round-robin', maxPerExecution: 1 } };

  for (let i = 0; i < 4; i++) {
    await handler.processRepositories(repos, {}, false, cfg);
  }

  assert.deepEqual(created.map(c => c.repo), ['a', 'b', 'c', 'a']);
});

test('a dry run does not advance the round-robin rotation', async () => {
  const { handler, created } = createHandler();
  const cursor = { index: 1 };
  handler.cursorStore = {
    getRoundRobinIndex: () => cursor.index,
    setRoundRobinIndex: (index) => { cursor.index = index; }
  };
  const repos = ['a', 'b', 'c'].map(name => repo({ repo: name }));
  const cfg = { ...config, repositorySelection: { strategy: 'round-robin', maxPerExecution: 1 } };

  await handler.processRepositories(repos, {}, true, cfg);
  await handler.processRepositories(repos, {}, true, cfg);
  assert.equal(cursor.index, 1);

  await handler.processRepositories(repos, {}, false, cfg);
  assert.deepEqual(created.map(c => c.repo), ['b']);
});

test('selection only spends slots on repositories that can take an issue now', async () => {
  const { handler, created } = createHandler();
  const repos = [
    repo({ repo: 'done', dailyTarget: { min: 1, max: 1 } }),
    repo({ repo: 'open' })
  ];
  const cfg = { ...config, repositorySelection: { strategy: 'sequential', maxPerExecution: 1 } };

  await handler.processRepositories(repos, {}, false, cfg);
  await handler.processRepositories(repos, {}, false, cfg);

  // First run fills 'done'; second run must not waste its only slot on it
  assert.deepEqual(created.map(c => c.repo), ['done', 'open']);
});

test('processes every ready repository when repositorySelection is omitted', async () => {
  const { handler, created } = createHandler();
  const repos = ['a', 'b', 'c'].map(name => repo({ repo: name }));

  await handler.processRepositories(repos, {}, false, config);

  assert.deepEqual(created.map(c => c.repo), ['a', 'b', 'c']);
});

test('renders ${date} and ${time} in the configured timezone', () => {
  const { handler } = createHandler();
  const now = new Date('2026-10-14T23:30:05Z');
  const tzConfig = {
    general: { timezone: 'Asia/Manila' },
    randomization: {},
    contentTemplates: [{ title: 'Update ${date} ${time}', body: 'At ${timestamp} on ${date}' }]
  };

  const { title, body } = handler.generateIssueContent(repo(), tzConfig, now);

  assert.equal(title, 'Update 2026-10-15 07:30:05');
  assert.equal(body, 'At 2026-10-14T23:30:05.000Z on 2026-10-15');
});

test('default issue title uses the configured timezone and falls back to UTC', () => {
  const { handler } = createHandler();
  const now = new Date('2026-10-15T00:05:00Z');

  const la = handler.generateIssueContent(repo(), { general: { timezone: 'America/Los_Angeles' } }, now);
  assert.equal(la.title, 'Automated Issue - 2026-10-14 17:05:00');

  const utc = handler.generateIssueContent(repo(), {}, now);
  assert.equal(utc.title, 'Automated Issue - 2026-10-15 00:05:00');
});

test('inserts configured titles literally, without replacement patterns or nested placeholders', () => {
  const { handler } = createHandler();
  const bugTitle = "Totals show $$ instead of $& for ${date} in $' and $`";
  const config = {
    randomization: { bugTitles: [bugTitle] },
    contentTemplates: [{ title: 'Bug: ${randomBugTitle}', body: '${randomBugTitle} in ${repo}' }]
  };

  const { title, body } = handler.generateIssueContent(repo({ repo: 'shop' }), config, new Date('2026-10-15T00:00:00Z'));

  assert.equal(title, `Bug: ${bugTitle}`);
  assert.equal(body, `${bugTitle} in shop`);
});

test('falls back to the default random titles when a title list is empty', () => {
  const { handler } = createHandler();
  const config = {
    randomization: { bugTitles: [], featureTitles: [], docTitles: [], perfTitles: [] },
    contentTemplates: [{ title: '${randomBugTitle}|${randomFeatureTitle}', body: '${randomDocTitle}|${randomPerfTitle}' }]
  };

  const { title, body } = handler.generateIssueContent(repo(), config);

  assert.equal(title, 'General bug|General feature');
  assert.equal(body, 'General documentation|General performance');
});

test('uses the configured contentTemplate when no contentTemplates list is set', () => {
  const { handler } = createHandler();
  const now = new Date('2026-10-15T00:05:00Z');
  const contentTemplate = { title: 'Progress ${date} for ${repo}', body: 'Logged at ${time}', labels: ['ignored'] };

  for (const contentTemplates of [undefined, []]) {
    const issue = handler.generateIssueContent(repo({ repo: 'shop' }), { contentTemplate, contentTemplates }, now);
    assert.equal(issue.title, 'Progress 2026-10-15 for shop');
    assert.equal(issue.body, 'Logged at 00:05:00');
    // Like simple issue mode, contentTemplate does not add labels
    assert.deepEqual(issue.labels, ['automated']);
  }
});

test('contentTemplates takes precedence over contentTemplate', () => {
  const { handler } = createHandler();
  const issue = handler.generateIssueContent(repo(), {
    contentTemplate: { title: 'Single', body: 'Single body' },
    contentTemplates: [{ title: 'From list', body: 'List body' }]
  });

  assert.equal(issue.title, 'From list');
  assert.equal(issue.body, 'List body');
});

test('fills a field the contentTemplate leaves out with the advanced default', () => {
  const { handler } = createHandler();
  const issue = handler.generateIssueContent(repo(), { contentTemplate: { body: 'Only a body' } }, new Date('2026-10-15T00:05:00Z'));

  assert.equal(issue.title, 'Automated Issue - 2026-10-15 00:05:00');
  assert.equal(issue.body, 'Only a body');
});

test('keeps the dated default title when the config has no contentTemplate', () => {
  const { handler } = createHandler();
  const cfg = loader.validate({ repositories: [{ owner: 'me', repo: 'demo' }] }, { requireToken: false });
  assert.equal(cfg.contentTemplate, DEFAULT_CONTENT_TEMPLATE);

  const issue = handler.generateIssueContent(repo(), cfg, new Date('2026-10-15T00:05:00Z'));

  assert.equal(issue.title, 'Automated Issue - 2026-10-15 00:05:00');
  assert.match(issue.body, /^# Automated Issue/);
});

test('leaves unknown placeholders as written', () => {
  const { handler } = createHandler();
  const config = { contentTemplates: [{ title: '${unknown} ${repo}', body: '${constructor} ${toString}' }] };

  const { title, body } = handler.generateIssueContent(repo({ repo: 'shop' }), config);

  assert.equal(title, '${unknown} shop');
  assert.equal(body, '${constructor} ${toString}');
});

test('waits between repositories that create issues but not after the last one', async () => {
  const { handler, created } = createHandler();
  const delays = [];
  handler.delay = async (ms) => { delays.push(ms); };

  await handler.processRepositories([repo({ repo: 'a' }), repo({ repo: 'b' }), repo({ repo: 'c' })], {}, false, config);

  assert.equal(created.length, 3);
  assert.deepEqual(delays, [1000, 1000]);
});

test('still waits after a failed create, since the request reached the API', async () => {
  const { handler } = createHandler();
  const delays = [];
  handler.delay = async (ms) => { delays.push(ms); };
  handler.client.issues.create = async () => { throw new Error('Validation Failed'); };

  const results = await handler.processRepositories([repo({ repo: 'a' }), repo({ repo: 'b' })], {}, false, config);

  assert.ok(results.every(r => !r.success));
  assert.deepEqual(delays, [1000]);
});

test('does not wait between repositories in a dry run or for skipped repositories', async () => {
  const { handler, created } = createHandler();
  const delays = [];
  handler.delay = async (ms) => { delays.push(ms); };

  const results = await handler.processRepositories([repo({ repo: 'a' }), repo({ repo: 'b' })], {}, true, config);
  assert.equal(created.length, 0);
  assert.ok(results.every(r => r.dryRun));

  // One ready repo plus two that are done for the day: nothing follows the API call
  await handler.processRepositories([
    repo({ repo: 'a' }),
    repo({ repo: 'done-1', dailyTarget: { min: 0, max: 0 } }),
    repo({ repo: 'done-2', enabled: false })
  ], {}, false, config);
  assert.equal(created.length, 1);
  assert.deepEqual(delays, []);
});
