import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import AdvancedIssueHandler from '../src/github/advanced-issue-handler.js';

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

test('status reports today\'s progress when state is from the current day', async () => {
  const { handler } = createHandler();
  const next = Date.now() + 60 * 60 * 1000;
  writeState(handler, {
    lastDailyReset: new Date().toISOString(),
    repositories: {
      'me/demo': { issuesCreatedToday: 2, lastIssueTime: Date.now(), todayTarget: 3, nextIssueTime: next }
    }
  });

  const { repositories: [status] } = await handler.getStatus([repo()], 'UTC');

  assert.equal(status.issuesCreatedToday, 2);
  assert.equal(status.todayTarget, 3);
  assert.equal(status.nextIssueTime, new Date(next).toISOString());
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
  assert.deepEqual(notSelected, ['me/b', 'me/c']);
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
