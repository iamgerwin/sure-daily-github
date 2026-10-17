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
import { MAX_ATTEMPTS } from '../src/utils/babysitter-ledger.js';
import { createReviewEngine } from '../src/utils/review-engine.js';
import { runProcess, killActiveEngines } from '../src/utils/process.js';

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

// `failReplies` / `failIssueComments`: how many of the first posts fail;
// `throwReplies`: the first inline reply throws (a crash mid-reply)
function stubClient({ issues = [{ number: 7, user: { login: 'me' }, pull_request: {} }], pulls = {}, reviewComments = [], reviews = [], issueComments = [], failReplies = 0, failIssueComments = 0, throwReplies = false } = {}) {
  const calls = { auth: 0, listLabeled: [], getPullRequest: [], replies: [], issueComments: [], failedPosts: 0 };
  let nextId = 1000;
  const ok = (data) => ({ success: true, data });
  const failure = () => { calls.failedPosts++; return { success: false, error: 'HTTP 502' }; };
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
      if (throwReplies) {
        throwReplies = false;
        throw new Error('process crashed');
      }
      if (failReplies > 0) { failReplies--; return failure(); }
      calls.replies.push({ number, commentId, body });
      return ok({ id: nextId++ });
    },
    createIssueComment: async (owner, repo, number, body) => {
      if (failIssueComments > 0) { failIssueComments--; return failure(); }
      calls.issueComments.push({ number, body });
      return ok({ id: nextId++ });
    }
  };
  return { client, calls };
}

// An implement report marking every item (or only `ids`) as implemented
function implemented(items, ids = items.map(i => i.comment.id)) {
  return { fixes: ids.map(id => ({ id, status: 'implemented', summary: '', locations: [] })), missing: [] };
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
      return implement ? implement(ctx) : { ok: true, report: implemented(ctx.items) };
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
      const fixes = [
        { id: 'review_comment:11', status: 'implemented', summary: 'Extracted VERSION constant', locations: [{ path: 'constants.txt', line: 1 }] },
        { id: 'review_comment:12', status: 'implemented', summary: '', locations: [] }
      ];
      fs.writeFileSync(reportFile, JSON.stringify({ fixes }));
      return { ok: true, report: { fixes, missing: [] } };
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
    implement: ({ cwd, items }) => {
      fs.writeFileSync(path.join(cwd, 'app.txt'), 'v3\n');
      return { ok: true, report: implemented(items) };
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
  // Nothing was pushed, so no bot is asked to re-review
  assert.doesNotMatch(summary, /re-review/);
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
    implement: ({ cwd, items }) => {
      commitFile(cwd, 'broken.txt', 'fix: break the build');
      return { ok: true, report: implemented(items) };
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
    implement: ({ cwd, items }) => {
      commitFile(cwd, 'fix.txt', 'fix: thing');
      return { ok: true, report: implemented(items) };
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

// A fix that commits one file and reports every item as implemented
const simpleFix = ({ cwd, items }) => {
  commitFile(cwd, 'fix.txt', 'fix: thing');
  return { ok: true, report: implemented(items) };
};

test('the scan resumes after the last visited PR, so idle PRs cannot starve the rest', async (t) => {
  useTmpState(t);
  const remote = setupRemote();
  const issues = [7, 8, 9].map(number => ({ number, user: { login: 'me' }, pull_request: {} }));
  const pulls = Object.fromEntries([7, 8, 9].map(number => [number, pull(remote.headSha, { number })]));
  const visited = [];

  for (let run = 0; run < 2; run++) {
    const { client, calls } = stubClient({ issues, pulls });
    await babysitter(remote, client, stubEngine().engine).execute(makeConfig({ maxPrsPerRun: 2 }));
    visited.push(calls.getPullRequest);
  }
  assert.deepEqual(visited, [[7, 8], [9, 7]]);
  assert.deepEqual([...new Set(visited.flat())].sort(), [7, 8, 9]);
});

test('a --repo scan rotates through the shared cursor, so filtered runs reach every PR', async (t) => {
  useTmpState(t);
  const remote = setupRemote();
  const issues = [7, 8, 9].map(number => ({ number, user: { login: 'me' }, pull_request: {} }));
  const pulls = Object.fromEntries([7, 8, 9].map(number => [number, pull(remote.headSha, { number })]));
  const visited = [];

  for (let run = 0; run < 2; run++) {
    const { client, calls } = stubClient({ issues, pulls });
    await babysitter(remote, client, stubEngine().engine).execute(makeConfig({ maxPrsPerRun: 2 }), { repos: ['me/demo'] });
    visited.push(calls.getPullRequest);
  }
  assert.deepEqual(visited, [[7, 8], [9, 7]]);
});

// Wraps the babysitter's push so `after(result)` runs right after it returns
function onPush(sitter, after) {
  const push = sitter.pushPinned.bind(sitter);
  sitter.pushPinned = async (...args) => {
    const result = await push(...args);
    await after(result);
    return result;
  };
}

test('a crash right after the remote push is reconciled from the push intent, not re-implemented', async (t) => {
  const state = useTmpState(t);
  const remote = setupRemote();
  const pulls = { 7: pull(remote.headSha) };
  const { client, calls } = stubClient({ pulls, reviewComments: [inlineAlice], issueComments: [bobComment] });
  const { engine, calls: engineCalls } = stubEngine({ actions: { 'review_comment:11': 'fix', 'issue_comment:31': 'note' }, implement: simpleFix });

  const sitter = babysitter(remote, client, engine);
  let snapshot;
  // What a crash right after the push leaves on disk
  onPush(sitter, () => { snapshot = fs.readFileSync(state.ledgerFile, 'utf8'); });
  await sitter.execute(makeConfig());
  fs.writeFileSync(state.ledgerFile, snapshot);
  calls.replies.length = 0;
  calls.issueComments.length = 0;

  const pushed = remote.remote('rev-parse', 'refs/heads/feature');
  assert.notEqual(pushed, remote.headSha);
  assert.equal(state.ledger().pushIntents['me/demo#7'].expectedSha, pushed);
  assert.deepEqual(state.ledger().comments, {}, 'no outcome was recorded before the crash');

  pulls[7] = pull(pushed);
  const second = await babysitter(remote, client, engine).execute(makeConfig());
  assert.equal(getBabysitExitCode(second), 0);
  assert.equal(engineCalls.implement, 1, 'not re-implemented');
  assert.equal(engineCalls.triage.length, 1, 'not re-triaged');
  assert.equal(calls.replies.length, 1);
  assert.ok(calls.replies[0].body.includes(`Fixed in ${pushed.slice(0, 12)}`));
  assert.equal(calls.issueComments.length, 1);
  const ledger = state.ledger();
  assert.equal(ledger.comments['me/demo#7/review_comment:11'].state, 'addressed');
  assert.equal(ledger.comments['me/demo#7/review_comment:11'].commitSha, pushed);
  assert.equal(ledger.comments['me/demo#7/issue_comment:31'].state, 'noted');
  assert.deepEqual(ledger.pushIntents, {});
  assert.equal(remote.remote('rev-parse', 'refs/heads/feature'), pushed, 'nothing pushed twice');
});

test('an interrupt right after a successful push is reconciled on the next run', async (t) => {
  const state = useTmpState(t);
  const remote = setupRemote();
  const pulls = { 7: pull(remote.headSha) };
  const { client, calls } = stubClient({ pulls, reviewComments: [inlineAlice] });
  const { engine, calls: engineCalls } = stubEngine({ actions: { 'review_comment:11': 'fix' }, implement: simpleFix });

  const sitter = new Babysitter({
    client, engine, token: null, remoteUrl: () => remote.bare, tmpDir: remote.root,
    killEngines: async () => {}, killTests: () => {}, exit: () => {}
  });
  let interrupting;
  onPush(sitter, () => { interrupting = sitter.interrupt('SIGTERM'); });
  await sitter.execute(makeConfig());
  await interrupting;

  const pushed = remote.remote('rev-parse', 'refs/heads/feature');
  assert.notEqual(pushed, remote.headSha);
  let ledger = state.ledger();
  assert.equal(ledger.pushIntents['me/demo#7'].expectedSha, pushed);
  assert.equal(ledger.comments['me/demo#7/review_comment:11'], undefined);
  assert.equal(calls.replies.length, 0);

  pulls[7] = pull(pushed);
  const second = await babysitter(remote, client, engine).execute(makeConfig());
  assert.equal(getBabysitExitCode(second), 0);
  assert.equal(engineCalls.implement, 1, 'not re-implemented');
  assert.equal(calls.replies.length, 1);
  ledger = state.ledger();
  assert.equal(ledger.comments['me/demo#7/review_comment:11'].state, 'addressed');
  assert.deepEqual(ledger.pushIntents, {});
});

test('a push intent whose SHA never reached the branch leaves the comments pending', async (t) => {
  const state = useTmpState(t);
  const remote = setupRemote();
  const pulls = { 7: pull(remote.headSha) };
  const { client, calls } = stubClient({ pulls, reviewComments: [inlineAlice] });
  const { engine, calls: engineCalls } = stubEngine({ actions: { 'review_comment:11': 'fix' }, implement: simpleFix });

  const sitter = babysitter(remote, client, engine);
  let snapshot;
  onPush(sitter, () => { snapshot = fs.readFileSync(state.ledgerFile, 'utf8'); });
  await sitter.execute(makeConfig());
  fs.writeFileSync(state.ledgerFile, snapshot);
  // As if the push never landed
  remote.remote('update-ref', 'refs/heads/feature', remote.headSha);
  calls.replies.length = 0;

  const second = await babysitter(remote, client, engine).execute(makeConfig());
  assert.match(second.results[0].reason, /did not land/);
  assert.equal(engineCalls.implement, 2, 'handled again as unprocessed');
  assert.equal(calls.replies.length, 1);
  assert.equal(state.ledger().comments['me/demo#7/review_comment:11'].state, 'addressed');
  assert.deepEqual(state.ledger().pushIntents, {});
});

test('a failed head lookup leaves a pending reply untouched and uncharged', async (t) => {
  const state = useTmpState(t);
  const remote = setupRemote();
  const pulls = { 7: pull(remote.headSha) };
  const { client, calls } = stubClient({ pulls, reviewComments: [inlineAlice], throwReplies: true });
  const { engine, calls: engineCalls } = stubEngine({ actions: { 'review_comment:11': 'fix' }, implement: simpleFix });

  await babysitter(remote, client, engine).execute(makeConfig());
  const pushed = remote.remote('rev-parse', 'refs/heads/feature');
  pulls[7] = pull(pushed);

  const getPullRequest = client.getPullRequest;
  client.getPullRequest = async () => ({ success: false, error: 'HTTP 503', status: 503 });
  const second = await babysitter(remote, client, engine).execute(makeConfig());
  assert.equal(getBabysitExitCode(second), 1);
  let ledger = state.ledger();
  const [delivery] = Object.values(ledger.deliveries);
  assert.equal(delivery.attempts, 0, 'no delivery attempt consumed');
  assert.equal(ledger.comments['me/demo#7/review_comment:11'].state, 'pushed', 'delivery guard kept');
  assert.equal(calls.replies.length, 0);

  client.getPullRequest = getPullRequest;
  const third = await babysitter(remote, client, engine).execute(makeConfig());
  assert.equal(getBabysitExitCode(third), 0);
  assert.equal(engineCalls.implement, 1);
  assert.equal(calls.replies.length, 1);
  ledger = state.ledger();
  assert.equal(ledger.comments['me/demo#7/review_comment:11'].state, 'addressed');
  assert.deepEqual(ledger.deliveries, {});
});

for (const infra of [false, true]) {
  test(`a ${infra ? 'spawn' : 'genuine'} failure in a later engine batch only affects that batch's items`, async (t) => {
    const state = useTmpState(t);
    const remote = setupRemote();
    const { client, calls } = stubClient({ pulls: { 7: pull(remote.headSha) }, reviewComments: [inlineAlice, inlineBot] });
    const { engine } = stubEngine({
      actions: { 'review_comment:11': 'fix', 'review_comment:12': 'fix' },
      implement: ({ cwd, items }) => {
        commitFile(cwd, 'fix.txt', 'fix: first batch');
        const report = implemented(items, ['review_comment:11']);
        return { ok: true, report: { ...report, batchFailures: [{ ids: ['review_comment:12'], infra, error: 'opencode exited with code 1' }] } };
      }
    });

    const result = await babysitter(remote, client, engine).execute(makeConfig());
    const pr = result.results[0];
    assert.equal(pr.counts.addressed, 1);
    assert.deepEqual(calls.replies.map(r => r.commentId), [11]);
    assert.equal(remote.remote('rev-parse', 'refs/heads/feature'), pr.commitSha);
    const ledger = state.ledger().comments;
    assert.equal(ledger['me/demo#7/review_comment:11'].state, 'addressed');
    if (infra) {
      assert.deepEqual(pr.retrying.map(r => r.id), ['review_comment:12']);
      assert.equal(ledger['me/demo#7/review_comment:12'], undefined, 'not charged');
    } else {
      assert.match(pr.failures[0].error, /engine failed: opencode exited with code 1/);
      assert.equal(ledger['me/demo#7/review_comment:12'].state, 'failed');
      assert.equal(ledger['me/demo#7/review_comment:12'].attempts, 1);
    }
  });
}

test('a failed inline reply for a pushed fix is retried next run without re-running the fix', async (t) => {
  const state = useTmpState(t);
  const remote = setupRemote();
  const { client, calls } = stubClient({ pulls: { 7: pull(remote.headSha) }, reviewComments: [inlineAlice], failReplies: 1 });
  const { engine, calls: engineCalls } = stubEngine({ actions: { 'review_comment:11': 'fix' }, implement: simpleFix });

  const first = await babysitter(remote, client, engine).execute(makeConfig());
  assert.equal(getBabysitExitCode(first), 1);
  const pushed = first.results[0].commitSha;
  assert.equal(remote.remote('rev-parse', 'refs/heads/feature'), pushed);
  let entry = state.ledger().comments['me/demo#7/review_comment:11'];
  assert.equal(entry.state, 'addressed');
  assert.equal(entry.replyPending, true);
  assert.equal(calls.replies.length, 0);

  const second = await babysitter(remote, client, engine).execute(makeConfig());
  assert.equal(getBabysitExitCode(second), 0);
  assert.equal(engineCalls.implement, 1, 'never re-implemented');
  assert.equal(engineCalls.triage.length, 1);
  assert.equal(calls.replies.length, 1);
  assert.ok(calls.replies[0].body.includes(`Fixed in ${pushed.slice(0, 12)}`));
  entry = state.ledger().comments['me/demo#7/review_comment:11'];
  assert.equal(entry.replyPending, undefined);
  assert.equal(entry.replyId, 1000);
  assert.deepEqual(state.ledger().deliveries, {});

  await babysitter(remote, client, engine).execute(makeConfig());
  assert.equal(calls.replies.length, 1, 'delivered exactly once');
});

test('a failed summary comment is retried on its own next run', async (t) => {
  const state = useTmpState(t);
  const remote = setupRemote();
  const { client, calls } = stubClient({ pulls: { 7: pull(remote.headSha) }, issueComments: [bobComment], failIssueComments: 1 });
  const { engine, calls: engineCalls } = stubEngine({ actions: { 'issue_comment:31': 'defer' } });

  const first = await babysitter(remote, client, engine).execute(makeConfig());
  assert.equal(first.results[0].counts.failed, 1);
  assert.equal(state.ledger().comments['me/demo#7/issue_comment:31'].state, 'deferred');
  assert.equal(state.ledger().comments['me/demo#7/issue_comment:31'].replyPending, true);

  const second = await babysitter(remote, client, engine).execute(makeConfig());
  assert.equal(getBabysitExitCode(second), 0);
  assert.equal(engineCalls.triage.length, 1, 'not triaged again');
  assert.equal(calls.issueComments.length, 1);
  assert.match(calls.issueComments[0].body, /\*\*deferred\*\*: because issue_comment:31/);
  assert.equal(state.ledger().comments['me/demo#7/issue_comment:31'].replyId, 1000);
});

test('a give-up notice whose post fails is delivered on a later run', async (t) => {
  const state = useTmpState(t);
  const remote = setupRemote();
  const { client, calls } = stubClient({ pulls: { 7: pull(remote.headSha) }, reviewComments: [inlineAlice] });
  const { engine, calls: engineCalls } = stubEngine({
    actions: { 'review_comment:11': 'fix' },
    implement: ({ cwd, items }) => {
      commitFile(cwd, 'broken.txt', 'fix: break the build');
      return { ok: true, report: implemented(items) };
    }
  });

  await babysitter(remote, client, engine).execute(makeConfig());
  const failing = stubClient({ pulls: { 7: pull(remote.headSha) }, reviewComments: [inlineAlice], failReplies: 1 });
  await babysitter(remote, failing.client, engine).execute(makeConfig());
  assert.equal(failing.calls.failedPosts, 1);
  assert.equal(state.ledger().comments['me/demo#7/review_comment:11'].state, 'failed');
  assert.equal(state.ledger().comments['me/demo#7/review_comment:11'].replyPending, true);

  await babysitter(remote, client, engine).execute(makeConfig());
  assert.equal(engineCalls.triage.length, 2, 'the give-up is not re-attempted');
  assert.equal(calls.replies.length, 1);
  assert.match(calls.replies[0].body, /Automated handling failed after 2 attempts/);
  assert.equal(state.ledger().comments['me/demo#7/review_comment:11'].replyId, 1000);
});

test('a crash between push and replies resumes reply delivery only', async (t) => {
  const state = useTmpState(t);
  const remote = setupRemote();
  const pulls = { 7: pull(remote.headSha) };
  const { client, calls } = stubClient({ pulls, reviewComments: [inlineAlice], throwReplies: true });
  const { engine, calls: engineCalls } = stubEngine({ actions: { 'review_comment:11': 'fix' }, implement: simpleFix });

  const first = await babysitter(remote, client, engine).execute(makeConfig());
  assert.match(first.results[0].error, /process crashed/);
  const pushed = remote.remote('rev-parse', 'refs/heads/feature');
  assert.notEqual(pushed, remote.headSha);
  // Recorded before the reply was attempted
  const entry = state.ledger().comments['me/demo#7/review_comment:11'];
  assert.equal(entry.state, 'pushed');
  assert.equal(entry.commitSha, pushed);
  assert.equal(Object.values(state.ledger().deliveries)[0].pushedSha, pushed);

  pulls[7] = pull(pushed);
  const second = await babysitter(remote, client, engine).execute(makeConfig());
  assert.equal(getBabysitExitCode(second), 0);
  assert.equal(engineCalls.implement, 1, 'not re-implemented');
  assert.equal(engineCalls.triage.length, 1);
  assert.equal(calls.replies.length, 1);
  assert.ok(calls.replies[0].body.includes(`Fixed in ${pushed.slice(0, 12)}`));
  assert.equal(state.ledger().comments['me/demo#7/review_comment:11'].state, 'addressed');
  assert.equal(remote.remote('rev-parse', 'refs/heads/feature'), pushed, 'nothing pushed twice');
});

test('an unacknowledged push whose branch moved on is settled with a note and no reply', async (t) => {
  const state = useTmpState(t);
  const remote = setupRemote();
  const pulls = { 7: pull(remote.headSha) };
  const { client, calls } = stubClient({ pulls, reviewComments: [inlineAlice], throwReplies: true });
  const { engine, calls: engineCalls } = stubEngine({ actions: { 'review_comment:11': 'fix' }, implement: simpleFix });

  await babysitter(remote, client, engine).execute(makeConfig());
  pulls[7] = pull('f'.repeat(40));
  const second = await babysitter(remote, client, engine).execute(makeConfig());
  assert.equal(calls.replies.length, 0);
  assert.equal(engineCalls.implement, 1);
  assert.match(second.results[0].reason, /branch moved after push/);
  const entry = state.ledger().comments['me/demo#7/review_comment:11'];
  assert.equal(entry.state, 'addressed');
  assert.match(entry.note, /branch moved after push/);
  assert.deepEqual(state.ledger().deliveries, {});
});

test('only fixes the report marks implemented settle; omitted ones stay pending uncharged', async (t) => {
  const state = useTmpState(t);
  const remote = setupRemote();
  const { client, calls } = stubClient({ pulls: { 7: pull(remote.headSha) }, reviewComments: [inlineAlice, inlineBot] });
  const { engine } = stubEngine({
    actions: { 'review_comment:11': 'fix', 'review_comment:12': 'fix' },
    implement: ({ cwd, items }) => {
      commitFile(cwd, 'fix.txt', 'fix: one of two');
      return { ok: true, report: { ...implemented(items, ['review_comment:11']), missing: ['review_comment:12'] } };
    }
  });

  const result = await babysitter(remote, client, engine).execute(makeConfig());
  const pr = result.results[0];
  assert.equal(pr.counts.addressed, 1);
  assert.deepEqual(pr.retrying.map(r => r.id), ['review_comment:12']);
  assert.equal(getBabysitExitCode(result), 1);
  assert.deepEqual(calls.replies.map(r => r.commentId), [11]);
  const ledger = state.ledger().comments;
  assert.equal(ledger['me/demo#7/review_comment:11'].state, 'addressed');
  assert.equal(ledger['me/demo#7/review_comment:12'], undefined, 'not settled and not charged');
});

test('a fix the report marks failed is charged an attempt and not settled', async (t) => {
  const state = useTmpState(t);
  const remote = setupRemote();
  const { client, calls } = stubClient({ pulls: { 7: pull(remote.headSha) }, reviewComments: [inlineAlice, inlineBot] });
  const { engine } = stubEngine({
    actions: { 'review_comment:11': 'fix', 'review_comment:12': 'fix' },
    implement: ({ cwd }) => {
      commitFile(cwd, 'fix.txt', 'fix: one of two');
      return {
        ok: true,
        report: {
          fixes: [
            { id: 'review_comment:11', status: 'implemented', summary: 'done', locations: [] },
            { id: 'review_comment:12', status: 'failed', summary: 'needs a schema change', locations: [] }
          ],
          missing: []
        }
      };
    }
  });

  const result = await babysitter(remote, client, engine).execute(makeConfig());
  assert.deepEqual(calls.replies.map(r => r.commentId), [11]);
  assert.match(result.results[0].failures[0].error, /engine could not fix this: needs a schema change/);
  const ledger = state.ledger().comments;
  assert.equal(ledger['me/demo#7/review_comment:12'].state, 'failed');
  assert.equal(ledger['me/demo#7/review_comment:12'].attempts, 1);
});

test('an engine that cannot be spawned (E2BIG) never exhausts the comment attempts', async (t) => {
  const state = useTmpState(t);
  const remote = setupRemote();
  const { client, calls } = stubClient({ pulls: { 7: pull(remote.headSha) }, reviewComments: [inlineAlice] });
  let spawns = 0;
  const runner = async () => {
    spawns++;
    throw Object.assign(new Error('spawn opencode E2BIG'), { code: 'E2BIG' });
  };
  const engine = createReviewEngine({ engine: 'opencode', model: 'm', runner });

  for (let run = 0; run < MAX_ATTEMPTS + 1; run++) {
    const result = await babysitter(remote, client, engine).execute(makeConfig());
    assert.equal(getBabysitExitCode(result), 1);
    assert.match(result.results[0].retrying[0].error, /E2BIG/);
  }
  assert.equal(spawns, MAX_ATTEMPTS + 1, 'retried every run');
  const ledger = fs.existsSync(state.ledgerFile) ? state.ledger().comments : {};
  assert.equal(ledger['me/demo#7/review_comment:11'], undefined, 'no attempt charged');
  assert.equal(calls.replies.length, 0, 'no give-up notice');
});

test('a push rejected because the branch moved is rescheduled, not charged', async (t) => {
  const state = useTmpState(t);
  const remote = setupRemote();
  const { client, calls } = stubClient({ pulls: { 7: pull(remote.headSha) }, reviewComments: [inlineAlice] });
  const { engine } = stubEngine({
    actions: { 'review_comment:11': 'fix' },
    implement: ({ cwd, items }) => {
      // Someone else pushes to the PR branch while the engine works
      commitFile(cwd, 'other.txt', 'feat: concurrent push');
      execFileSync('git', ['push', '-q', remote.bare, 'HEAD:refs/heads/feature'], { cwd });
      execFileSync('git', ['reset', '-q', '--hard', 'HEAD~1'], { cwd });
      commitFile(cwd, 'fix.txt', 'fix: thing');
      return { ok: true, report: implemented(items) };
    }
  });

  const result = await babysitter(remote, client, engine).execute(makeConfig());
  const pr = result.results[0];
  assert.equal(pr.counts.failed, 0);
  assert.equal(getBabysitExitCode(result), 0);
  assert.deepEqual(pr.retrying, [{ id: 'review_comment:11', error: 'PR branch changed before push' }]);
  assert.equal(calls.replies.length, 0);
  const ledger = fs.existsSync(state.ledgerFile) ? state.ledger().comments : {};
  assert.equal(ledger['me/demo#7/review_comment:11'], undefined, 'still pending, no attempt used');
});

test('a push declined by a server hook is a charged failure that ends in a give-up notice', async (t) => {
  const state = useTmpState(t);
  const remote = setupRemote();
  fs.writeFileSync(path.join(remote.bare, 'hooks', 'pre-receive'), '#!/bin/sh\necho "protected branch" >&2\nexit 1\n', { mode: 0o755 });
  const { client, calls } = stubClient({ pulls: { 7: pull(remote.headSha) }, reviewComments: [inlineAlice] });
  const { engine } = stubEngine({ actions: { 'review_comment:11': 'fix' }, implement: simpleFix });

  const first = await babysitter(remote, client, engine).execute(makeConfig());
  const pr = first.results[0];
  assert.equal(getBabysitExitCode(first), 1);
  assert.deepEqual(pr.retrying, []);
  assert.match(pr.failures[0].error, /git push failed: .*hook declined/s);
  assert.equal(state.ledger().comments['me/demo#7/review_comment:11'].attempts, 1);
  assert.deepEqual(state.ledger().pushIntents, {});
  assert.equal(remote.remote('rev-parse', 'refs/heads/feature'), remote.headSha);

  await babysitter(remote, client, engine).execute(makeConfig());
  assert.equal(calls.replies.length, 1);
  assert.match(calls.replies[0].body, /Automated handling failed after 2 attempts \(git push failed/);
});

test('bots are asked to re-review once per pushed head', async (t) => {
  useTmpState(t);
  const remote = setupRemote();
  const secondBot = { ...inlineBot, id: 14, body: 'Another nit' };
  const { client, calls } = stubClient({
    pulls: { 7: pull(remote.headSha) }, reviewComments: [inlineBot, secondBot], reviews: [botReview]
  });
  const { engine } = stubEngine({
    actions: { 'review_comment:12': 'fix', 'review_comment:14': 'fix', 'review:21': 'note' },
    implement: simpleFix
  });

  await babysitter(remote, client, engine).execute(makeConfig());
  const bodies = [...calls.replies, ...calls.issueComments].map(r => r.body).join('\n');
  assert.equal((bodies.match(/@coderabbitai please re-review/g) || []).length, 1);
  assert.match(calls.replies[0].body, /@coderabbitai please re-review\./);
  assert.doesNotMatch(calls.replies[1].body, /re-review/);
  assert.doesNotMatch(calls.issueComments[0].body, /re-review/);
});

test('an interrupt kills the engine group and its grandchild, cleans the workspace, and releases the lock', async (t) => {
  const state = useTmpState(t);
  const remote = setupRemote();
  const pidFile = path.join(path.dirname(state.ledgerFile), 'pids');
  const { client } = stubClient({ pulls: { 7: pull(remote.headSha) }, reviewComments: [inlineAlice] });
  const script = `
    const { spawn } = require('child_process');
    const g = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    require('fs').writeFileSync(${JSON.stringify(pidFile)}, process.pid + ' ' + g.pid);
    setInterval(() => {}, 1000);`;
  const engine = {
    triage: async ({ cwd }) => {
      const result = await runProcess(process.execPath, ['-e', script], { cwd });
      return { ok: false, error: `engine exited ${result.code}` };
    },
    implement: async () => assert.fail('implement must not run')
  };
  let exited;
  const exitCode = new Promise(resolve => { exited = resolve; });
  const listeners = process.listenerCount('SIGTERM');
  const sitter = new Babysitter({
    client, engine, token: null, remoteUrl: () => remote.bare, tmpDir: remote.root,
    killEngines: () => killActiveEngines({ graceMs: 300 }), exit: exited
  });

  const run = sitter.execute(makeConfig());
  while (!fs.existsSync(pidFile) || !fs.readFileSync(pidFile, 'utf8').includes(' ')) await new Promise(r => setTimeout(r, 20));
  const pids = fs.readFileSync(pidFile, 'utf8').split(' ').map(Number);
  assert.equal(process.listenerCount('SIGTERM'), listeners + 1, 'handler installed during the run');

  sitter.interrupt('SIGTERM');
  sitter.interrupt('SIGTERM');
  assert.equal(await exitCode, 143);
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), /ESRCH/, `pid ${pid} is gone`);
  assert.equal(fs.existsSync(state.lockFile), false, 'lock released');
  assert.deepEqual(fs.readdirSync(remote.root).filter(name => name.startsWith('sdg-babysit-')), [], 'workspace removed');

  await run;
  assert.equal(process.listenerCount('SIGTERM'), listeners, 'handler removed');
  const ledger = state.ledger();
  assert.equal(ledger.comments['me/demo#7/review_comment:11'], undefined, 'no attempt charged');
  assert.equal(ledger.prs['me/demo#7'].interrupted.signal, 'SIGTERM');
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
