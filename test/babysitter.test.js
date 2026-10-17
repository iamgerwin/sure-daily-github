import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  Babysitter,
  REPLY_MARKER,
  getBabysitExitCode,
  stripAttribution,
  mentionFor,
  normalizeComments
} from '../src/core/babysitter.js';
import { BABYSIT_DEFAULTS } from '../src/config/loader.js';

const GIT_ID = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false'];

function git(cwd, ...args) {
  return execFileSync('git', [...GIT_ID, ...args], { cwd, encoding: 'utf8' }).trim();
}

// Bare "GitHub" remote with main and a feature branch one commit ahead
function setupRemote() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-babysit-test-'));
  const bare = path.join(root, 'remote.git');
  git(root, 'init', '-q', '--bare', bare);
  const seed = path.join(root, 'seed');
  git(root, 'init', '-q', seed);
  fs.writeFileSync(path.join(seed, 'app.txt'), 'v1\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'chore: initial');
  git(seed, 'push', '-q', bare, 'HEAD:refs/heads/main');
  git(seed, 'checkout', '-q', '-b', 'feature');
  fs.writeFileSync(path.join(seed, 'app.txt'), 'v2\n');
  git(seed, 'commit', '-q', '-am', 'feat: v2');
  git(seed, 'push', '-q', bare, 'HEAD:refs/heads/feature');
  const headSha = git(seed, 'rev-parse', 'HEAD');
  return {
    root,
    bare,
    headSha,
    remote: (...args) => git(root, '--git-dir', bare, ...args)
  };
}

function useTmpState(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-babysit-state-'));
  const ledgerFile = path.join(dir, 'babysitter-state.json');
  const lockFile = path.join(dir, 'run.lock');
  process.env.SDG_BABYSITTER_STATE_FILE = ledgerFile;
  process.env.SDG_RUN_LOCK_FILE = lockFile;
  t.after(() => {
    delete process.env.SDG_BABYSITTER_STATE_FILE;
    delete process.env.SDG_RUN_LOCK_FILE;
  });
  return {
    ledgerFile,
    lockFile,
    ledger: () => JSON.parse(fs.readFileSync(ledgerFile, 'utf8'))
  };
}

function makeConfig(babysit = {}, repositories = null) {
  return {
    repositories: repositories || [{ owner: 'me', repo: 'demo', enabled: true, testCommand: 'test ! -f broken.txt' }],
    babysit: { ...BABYSIT_DEFAULTS, ...babysit }
  };
}

function pull(headSha, overrides = {}) {
  return {
    number: 7,
    state: 'open',
    title: 'Add v2',
    user: { login: 'me' },
    head: { ref: 'feature', sha: headSha, repo: { full_name: 'me/demo' } },
    base: { ref: 'main', repo: { full_name: 'me/demo' } },
    ...overrides
  };
}

const alice = { login: 'alice', type: 'User' };
const rabbit = { login: 'coderabbitai[bot]', type: 'Bot' };
const inlineAlice = { id: 11, user: alice, body: 'Use a constant here', path: 'app.txt', line: 1, diff_hunk: '@@ -1 +1 @@', html_url: 'https://gh/c/11' };
const inlineBot = { id: 12, user: rabbit, body: 'Potential bug: v2 is hardcoded', path: 'app.txt', line: 1, html_url: 'https://gh/c/12' };
const botReview = { id: 21, state: 'COMMENTED', user: rabbit, body: 'Actionable comments posted: 1', html_url: 'https://gh/r/21' };
const bobComment = { id: 31, user: { login: 'bob', type: 'User' }, body: 'Could you also update the docs?', html_url: 'https://gh/i/31' };

function stubClient({ issues = [{ number: 7, user: { login: 'me' }, pull_request: {} }], pulls = {}, reviewComments = [], reviews = [], issueComments = [] } = {}) {
  const calls = { auth: 0, listLabeled: [], getPullRequest: [], replies: [], issueComments: [] };
  let nextId = 1000;
  const ok = (data) => ({ success: true, data });
  const client = {
    getAuthenticatedUser: async () => { calls.auth++; return ok({ login: 'me', id: 1 }); },
    listLabeledPullRequests: async (owner, repo, label) => {
      calls.listLabeled.push({ owner, repo, label });
      return ok(issues);
    },
    getPullRequest: async (owner, repo, number) => {
      calls.getPullRequest.push(number);
      return ok(pulls[number]);
    },
    listReviewComments: async () => ok(reviewComments),
    listReviews: async () => ok(reviews),
    listIssueComments: async () => ok(issueComments),
    replyToReviewComment: async (owner, repo, number, commentId, body) => {
      calls.replies.push({ number, commentId, body });
      return ok({ id: nextId++ });
    },
    createIssueComment: async (owner, repo, number, body) => {
      calls.issueComments.push({ number, body });
      return ok({ id: nextId++ });
    }
  };
  return { client, calls };
}

// Decides each comment from `actions` (keyed by kind-prefixed id) and runs
// `implement` (if given) for the fix step, like an engine working in the clone
function stubEngine({ actions = {}, implement } = {}) {
  const calls = { triage: [], implement: 0 };
  const engine = {
    triage: async ({ comments }) => {
      calls.triage.push(comments.map(c => c.id));
      return {
        ok: true,
        decisions: comments
          .filter(c => actions[c.id])
          .map(c => ({ id: c.id, action: actions[c.id], reasoning: `because ${c.id}`, plan: `plan ${c.id}` }))
      };
    },
    implement: async (ctx) => {
      calls.implement++;
      return implement ? implement(ctx) : { ok: true, report: null };
    }
  };
  return { engine, calls };
}

function commitFile(cwd, name, message) {
  fs.writeFileSync(path.join(cwd, name), 'changed\n');
  execFileSync('git', ['add', '-A'], { cwd });
  execFileSync('git', ['commit', '-q', '-m', message], { cwd });
}

function babysitter(remote, client, engine) {
  return new Babysitter({ client, engine, token: null, remoteUrl: () => remote.bare, tmpDir: remote.root });
}

test('stripAttribution removes co-author trailers and generated-with footers', () => {
  assert.equal(
    stripAttribution('fix: thing\n\nBody line\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n'),
    'fix: thing\n\nBody line\n'
  );
  assert.equal(
    stripAttribution('fix: x\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\nco-authored-by: a <b>\n'),
    'fix: x\n'
  );
  assert.equal(stripAttribution('Co-Authored-By: a <b>\n'), 'fix: address review feedback\n');
});

test('mentionFor tags bots without the [bot] suffix and never humans', () => {
  assert.equal(mentionFor(rabbit), '@coderabbitai');
  assert.equal(mentionFor({ login: 'github-actions[bot]', type: 'Bot' }), '@github-actions');
  assert.equal(mentionFor(alice), null);
  assert.equal(mentionFor(null), null);
});

test('normalizeComments merges all three sources and drops pending, empty, own, and babysit comments', () => {
  const comments = normalizeComments({
    reviewComments: [inlineAlice, { ...inlineBot, id: 13, in_reply_to_id: 12 }],
    reviews: [botReview, { id: 22, state: 'PENDING', user: rabbit, body: 'draft' }, { id: 23, state: 'APPROVED', user: alice, body: '' }],
    issueComments: [
      bobComment,
      { id: 32, user: { login: 'Me', type: 'User' }, body: '@coderabbitai review' },
      { id: 33, user: alice, body: `Fixed in abc\n\n${REPLY_MARKER}` }
    ]
  }, { login: 'me' });

  assert.deepEqual(comments.map(c => c.id), ['review_comment:11', 'review_comment:13', 'review:21', 'issue_comment:31']);
  assert.equal(comments[1].replyToId, 12, 'replies target the thread root');
  assert.equal(comments[0].path, 'app.txt');
});

test('scan only queries enabled repos with the configured label and honors ownPRsOnly and maxPrsPerRun', async (t) => {
  useTmpState(t);
  const remote = setupRemote();
  const issues = [
    { number: 7, user: { login: 'ME' }, pull_request: {} },
    { number: 8, user: { login: 'stranger' }, pull_request: {} }
  ];
  const pulls = { 7: pull(remote.headSha, { state: 'closed' }), 8: pull(remote.headSha, { number: 8, state: 'closed' }) };
  const repositories = [
    { owner: 'me', repo: 'demo', enabled: true },
    { owner: 'me', repo: 'off', enabled: false }
  ];

  let { client, calls } = stubClient({ issues, pulls });
  let result = await babysitter(remote, client, stubEngine().engine).execute(makeConfig({ label: 'please-babysit' }, repositories));
  assert.equal(result.success, true);
  assert.deepEqual(calls.listLabeled, [{ owner: 'me', repo: 'demo', label: 'please-babysit' }]);
  assert.deepEqual(calls.getPullRequest, [7]);
  assert.equal(result.results[0].reason, 'pull request is not open');

  ({ client, calls } = stubClient({ issues, pulls }));
  await babysitter(remote, client, stubEngine().engine).execute(makeConfig({ ownPRsOnly: false }, repositories));
  assert.deepEqual(calls.getPullRequest, [7, 8]);

  ({ client, calls } = stubClient({ issues, pulls }));
  await babysitter(remote, client, stubEngine().engine).execute(makeConfig({ ownPRsOnly: false, maxPrsPerRun: 1 }, repositories));
  assert.deepEqual(calls.getPullRequest, [7]);

  ({ client, calls } = stubClient({ issues, pulls }));
  await babysitter(remote, client, stubEngine().engine).execute(makeConfig({ ownPRsOnly: false }, repositories), { pr: 8 });
  assert.deepEqual(calls.getPullRequest, [8]);
});

test('--repo restrictions never query unconfigured or disabled repositories', async (t) => {
  useTmpState(t);
  const remote = setupRemote();
  const repositories = [{ owner: 'me', repo: 'demo', enabled: true }, { owner: 'me', repo: 'off', enabled: false }];

  for (const [repos, pattern] of [[['me/other'], /me\/other is not configured/], [['me/off'], /me\/off is disabled/]]) {
    const { client, calls } = stubClient();
    const result = await babysitter(remote, client, stubEngine().engine).execute(makeConfig({}, repositories), { repos });
    assert.equal(result.success, false);
    assert.match(result.error, pattern);
    assert.equal(getBabysitExitCode(result), 1);
    assert.deepEqual(calls.listLabeled, []);
  }

  const { client, calls } = stubClient({ issues: [] });
  await babysitter(remote, client, stubEngine().engine).execute(makeConfig({}, repositories), { repos: ['ME/Demo'] });
  assert.deepEqual(calls.listLabeled.map(c => c.repo), ['demo']);
});

test('a fork PR is told once that it cannot be pushed to and skipped afterwards', async (t) => {
  useTmpState(t);
  const remote = setupRemote();
  const pulls = { 7: pull(remote.headSha, { head: { ref: 'feature', sha: remote.headSha, repo: { full_name: 'stranger/demo' } } }) };
  const { engine, calls: engineCalls } = stubEngine();

  const { client, calls } = stubClient({ pulls, reviewComments: [inlineAlice] });
  const first = await babysitter(remote, client, engine).execute(makeConfig());
  const second = await babysitter(remote, client, engine).execute(makeConfig());

  assert.equal(first.results[0].skipped, true);
  assert.match(first.results[0].reason, /fork/);
  assert.equal(second.results[0].skipped, true);
  assert.equal(calls.issueComments.length, 1);
  assert.match(calls.issueComments[0].body, /`stranger\/demo`/);
  assert.ok(calls.issueComments[0].body.includes(REPLY_MARKER));
  assert.equal(engineCalls.triage.length, 0);
  assert.equal(getBabysitExitCode(second), 0);
});

test('fix path pushes a fast-forward commit at the tested SHA, strips attribution, and replies with the sha', async (t) => {
  const state = useTmpState(t);
  const remote = setupRemote();
  const { client, calls } = stubClient({ pulls: { 7: pull(remote.headSha) }, reviewComments: [inlineAlice, inlineBot] });
  const { engine, calls: engineCalls } = stubEngine({
    actions: { 'review_comment:11': 'fix', 'review_comment:12': 'fix' },
    implement: ({ cwd, reportFile, items }) => {
      assert.deepEqual(items.map(i => i.comment.id), ['review_comment:11', 'review_comment:12']);
      commitFile(cwd, 'constants.txt', 'fix: use a constant\n\nCo-Authored-By: Claude <noreply@anthropic.com>');
      commitFile(cwd, 'app.txt', 'fix: drop hardcoded value\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)');
      fs.writeFileSync(reportFile, JSON.stringify({
        fixes: [{ id: 'review_comment:11', summary: 'Extracted VERSION constant', locations: [{ path: 'constants.txt', line: 1 }] }]
      }));
      return { ok: true, report: { fixes: [{ id: 'review_comment:11', summary: 'Extracted VERSION constant', locations: [{ path: 'constants.txt', line: 1 }] }] } };
    }
  });

  const result = await babysitter(remote, client, engine).execute(makeConfig());
  assert.equal(result.success, true);
  assert.equal(getBabysitExitCode(result), 0);
  const pr = result.results[0];
  assert.equal(pr.counts.addressed, 2);
  assert.equal(pr.counts.failed, 0);

  // Pushed exactly the reported SHA, as a fast-forward on top of the PR head
  assert.equal(remote.remote('rev-parse', 'refs/heads/feature'), pr.commitSha);
  assert.equal(remote.remote('rev-parse', `${pr.commitSha}~2`), remote.headSha);
  const messages = remote.remote('log', '--format=%B', `${remote.headSha}..${pr.commitSha}`);
  assert.doesNotMatch(messages, /Co-Authored-By|Generated with/i);
  assert.match(messages, /fix: use a constant/);
  assert.match(messages, /fix: drop hardcoded value/);
  // Engine commits use the clone's identity (the authenticated user) and keep it through the rewrite
  assert.equal(remote.remote('log', '-1', '--format=%an <%ae>', pr.commitSha), 'me <1+me@users.noreply.github.com>');

  // One reply per thread with the commit, the change location, and a re-review request
  assert.deepEqual(calls.replies.map(r => r.commentId), [11, 12]);
  const [human, bot] = calls.replies.map(r => r.body);
  assert.ok(human.includes(`Fixed in ${pr.commitSha.slice(0, 12)}: Extracted VERSION constant`));
  assert.ok(human.includes('`constants.txt:1`'));
  assert.match(human, /Please re-review\./);
  assert.doesNotMatch(human, /@alice/);
  assert.match(bot, /@coderabbitai please re-review\./);
  assert.doesNotMatch(bot, /\[bot\]/);
  assert.ok(bot.includes('plan review_comment:12'), 'falls back to the triage plan without a report entry');
  assert.ok(bot.includes(REPLY_MARKER));

  const entry = state.ledger().comments['me/demo#7/review_comment:11'];
  assert.equal(entry.state, 'addressed');
  assert.equal(entry.commitSha, pr.commitSha);
  assert.equal(entry.headSha, remote.headSha);
  assert.equal(entry.replyId, 1000);

  // Second run: everything is in the ledger, so nothing is triaged or replied
  const again = await babysitter(remote, client, engine).execute(makeConfig());
  assert.equal(again.results[0].reason, 'no new review comments');
  assert.equal(engineCalls.triage.length, 1);
  assert.equal(engineCalls.implement, 1);
  assert.equal(calls.replies.length, 2);
});

test('engine edits left uncommitted are committed by the orchestrator before the gate', async (t) => {
  useTmpState(t);
  const remote = setupRemote();
  const { client } = stubClient({ pulls: { 7: pull(remote.headSha) }, reviewComments: [inlineAlice] });
  const { engine } = stubEngine({
    actions: { 'review_comment:11': 'fix' },
    implement: ({ cwd }) => {
      fs.writeFileSync(path.join(cwd, 'app.txt'), 'v3\n');
      return { ok: true, report: null };
    }
  });

  const result = await babysitter(remote, client, engine).execute(makeConfig());
  const pr = result.results[0];
  assert.equal(pr.counts.addressed, 1);
  assert.equal(remote.remote('log', '-1', '--format=%s', 'refs/heads/feature'), 'fix: address review feedback on #7');
  assert.equal(remote.remote('rev-parse', `${pr.commitSha}~1`), remote.headSha);
});

test('defer, wontfix, and note get precise replies, bots are tagged, and nothing is reprocessed', async (t) => {
  const state = useTmpState(t);
  const remote = setupRemote();
  const { client, calls } = stubClient({
    pulls: { 7: pull(remote.headSha) },
    reviewComments: [inlineAlice],
    reviews: [botReview],
    issueComments: [bobComment]
  });
  const { engine, calls: engineCalls } = stubEngine({
    actions: { 'review_comment:11': 'defer', 'review:21': 'wontfix', 'issue_comment:31': 'note' }
  });

  const result = await babysitter(remote, client, engine).execute(makeConfig());
  const pr = result.results[0];
  assert.deepEqual(pr.counts, { addressed: 0, deferred: 1, wontfix: 1, noted: 1, failed: 0 });
  assert.equal(pr.commitSha, null);
  assert.equal(engineCalls.implement, 0);
  assert.equal(remote.remote('rev-parse', 'refs/heads/feature'), remote.headSha, 'nothing pushed');

  assert.equal(calls.replies.length, 1);
  assert.match(calls.replies[0].body, /Deferring this: because review_comment:11/);
  assert.match(calls.replies[0].body, /Follow-up: plan review_comment:11/);

  assert.equal(calls.issueComments.length, 1);
  const summary = calls.issueComments[0].body;
  assert.ok(summary.includes('[review](https://gh/r/21) by `coderabbitai[bot]`: **won\'t fix**: because review:21'));
  assert.ok(summary.includes('[comment](https://gh/i/31) by `bob`: **noted**: because issue_comment:31'));
  assert.match(summary, /@coderabbitai please re-review the latest changes\./);
  assert.doesNotMatch(summary, /@bob/);
  assert.ok(summary.includes(REPLY_MARKER));

  const ledger = state.ledger().comments;
  assert.equal(ledger['me/demo#7/review_comment:11'].state, 'deferred');
  assert.equal(ledger['me/demo#7/review:21'].state, 'wontfix');
  assert.equal(ledger['me/demo#7/issue_comment:31'].state, 'noted');
  assert.equal(ledger['me/demo#7/review:21'].replyId, ledger['me/demo#7/issue_comment:31'].replyId);

  await babysitter(remote, client, engine).execute(makeConfig());
  assert.equal(engineCalls.triage.length, 1);
  assert.equal(calls.replies.length, 1);
  assert.equal(calls.issueComments.length, 1);
});

test('a failing test gate pushes nothing, retries once, then replies that it gave up', async (t) => {
  const state = useTmpState(t);
  const remote = setupRemote();
  const { client, calls } = stubClient({ pulls: { 7: pull(remote.headSha) }, reviewComments: [inlineAlice] });
  const { engine, calls: engineCalls } = stubEngine({
    actions: { 'review_comment:11': 'fix' },
    implement: ({ cwd }) => {
      commitFile(cwd, 'broken.txt', 'fix: break the build');
      return { ok: true, report: null };
    }
  });

  const first = await babysitter(remote, client, engine).execute(makeConfig());
  assert.equal(first.results[0].success, false);
  assert.equal(first.summary.failed, 1);
  assert.equal(getBabysitExitCode(first), 1);
  assert.match(first.results[0].failures[0].error, /tests failed \(test ! -f broken.txt\)/);
  assert.equal(remote.remote('rev-parse', 'refs/heads/feature'), remote.headSha);
  assert.equal(calls.replies.length, 0, 'no reply while a retry is pending');
  assert.equal(state.ledger().comments['me/demo#7/review_comment:11'].attempts, 1);

  const second = await babysitter(remote, client, engine).execute(makeConfig());
  assert.equal(getBabysitExitCode(second), 1);
  assert.equal(calls.replies.length, 1);
  assert.match(calls.replies[0].body, /Automated handling failed after 2 attempts \(tests failed/);
  assert.equal(state.ledger().comments['me/demo#7/review_comment:11'].state, 'failed');

  const third = await babysitter(remote, client, engine).execute(makeConfig());
  assert.equal(third.results[0].reason, 'no new review comments');
  assert.equal(engineCalls.triage.length, 2);
  assert.equal(remote.remote('rev-parse', 'refs/heads/feature'), remote.headSha);
});

test('a repository without a detectable test command is never pushed to', async (t) => {
  useTmpState(t);
  const remote = setupRemote();
  const { client } = stubClient({ pulls: { 7: pull(remote.headSha) }, reviewComments: [inlineAlice] });
  const { engine } = stubEngine({
    actions: { 'review_comment:11': 'fix' },
    implement: ({ cwd }) => {
      commitFile(cwd, 'fix.txt', 'fix: thing');
      return { ok: true, report: null };
    }
  });

  const result = await babysitter(remote, client, engine)
    .execute(makeConfig({}, [{ owner: 'me', repo: 'demo', enabled: true, testCommand: null }]));
  assert.match(result.results[0].failures[0].error, /no test command detected/);
  assert.equal(remote.remote('rev-parse', 'refs/heads/feature'), remote.headSha);
});

test('dry run triages and reports planned actions without pushing, replying, or recording', async (t) => {
  const state = useTmpState(t);
  const remote = setupRemote();
  const { client, calls } = stubClient({ pulls: { 7: pull(remote.headSha) }, reviewComments: [inlineAlice], issueComments: [bobComment] });
  const { engine, calls: engineCalls } = stubEngine({ actions: { 'review_comment:11': 'fix' } });

  const result = await babysitter(remote, client, engine).execute(makeConfig(), { dryRun: true });
  assert.equal(result.dryRun, true);
  const pr = result.results[0];
  assert.deepEqual(pr.planned.map(p => [p.id, p.action]), [['review_comment:11', 'fix']]);
  assert.deepEqual(pr.undecided, ['issue_comment:31']);
  assert.equal(engineCalls.triage.length, 1);
  assert.equal(engineCalls.implement, 0);
  assert.equal(calls.replies.length, 0);
  assert.equal(calls.issueComments.length, 0);
  assert.equal(fs.existsSync(state.ledgerFile), false);
  assert.equal(remote.remote('rev-parse', 'refs/heads/feature'), remote.headSha);
});

test('the temporary clone is removed after each pull request', async (t) => {
  useTmpState(t);
  const remote = setupRemote();
  const { client } = stubClient({ pulls: { 7: pull(remote.headSha) }, reviewComments: [inlineAlice] });
  const { engine } = stubEngine({ actions: { 'review_comment:11': 'note' } });

  await babysitter(remote, client, engine).execute(makeConfig());
  assert.deepEqual(fs.readdirSync(remote.root).filter(name => name.startsWith('sdg-babysit-')), []);
});

test('a held run lock skips the scan without touching GitHub', async (t) => {
  const state = useTmpState(t);
  const remote = setupRemote();
  // The parent process (the test runner) is guaranteed to be alive
  fs.writeFileSync(state.lockFile, JSON.stringify({ pid: process.ppid, startedAt: Date.now() }));
  const { client, calls } = stubClient({ pulls: { 7: pull(remote.headSha) }, reviewComments: [inlineAlice] });

  const result = await babysitter(remote, client, stubEngine().engine).execute(makeConfig());
  assert.equal(result.locked, true);
  assert.equal(result.success, true);
  assert.match(result.error, new RegExp(`pid ${process.ppid}`));
  assert.equal(calls.auth, 0);
  assert.equal(getBabysitExitCode(result), 0);
  assert.equal(fs.existsSync(state.lockFile), true, 'foreign lock must be left in place');
});
