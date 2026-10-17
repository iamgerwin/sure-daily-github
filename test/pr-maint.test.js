import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PrMaint, decide, fingerprint, recordEscalation, renderDashboard, prMaintLockFile, getPrMaintExitCode, sha1, renderSticky,
  MAX_DASHBOARD_ROWS
} from '../src/core/pr-maint.js';
import { PrMaintGitHub, normalizePullRequest } from '../src/github/pr-labels.js';
import { PrMaintLedger } from '../src/utils/pr-maint-ledger.js';
import { acquireRunLock } from '../src/utils/run-lock.js';
import { PR_MAINT_DEFAULTS } from '../src/config/loader.js';
import { MARKERS, MERGE_POLICY_CONTEXT, NEEDS_HUMAN, PAUSED, NEEDS_HUMAN_WINDOW_MS, MAX_TEXT_BYTES } from '../src/core/policy.js';

const OWNER = 'iamgerwin';
const NOW = Date.UTC(2026, 9, 17, 12);
const sha = (c) => c.repeat(40);

// A normalized snapshot PR (what decide() reads)
function pr(number, overrides = {}) {
  return {
    number,
    isDraft: false,
    isCrossRepository: false,
    headRefName: `auto-pr/${number}`,
    headRefOid: sha('a'),
    baseRefName: 'master',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    author: OWNER,
    labels: [],
    reviewThreads: [],
    reviews: [],
    checks: 'SUCCESS',
    mergePolicy: null,
    ...overrides
  };
}

const opts = (overrides = {}) => ({ mode: 'act', authors: [OWNER], owner: OWNER, now: NOW, pr: null, ...overrides });
const emptyLedger = () => ({ prs: {}, escalations: {}, dashboard: {} });
const labelOps = (row) => row.actions.filter(a => a.type.startsWith('label.')).map(a => `${a.type === 'label.add' ? '+' : '-'}${a.payload.label}`);
const types = (row) => row.actions.map(a => a.type);
const only = (snapshotPrs, ledger = emptyLedger(), o = {}) => decide({ prs: snapshotPrs }, ledger, opts(o)).prs;

// ---- decide(): the label state machine ----

test('decide: a clean PR without a lifecycle label goes to sdg:waiting with a placeholder status and sticky', () => {
  const [row] = only([pr(1)]);
  assert.deepEqual(labelOps(row), ['+sdg:waiting']);
  assert.deepEqual(types(row), ['label.add', 'status.post', 'comment.upsert']);
  const status = row.actions.find(a => a.type === 'status.post');
  assert.deepEqual(status.payload, { context: MERGE_POLICY_CONTEXT, state: 'pending', description: 'Merge policy not evaluated yet' });
  assert.equal(status.headSha, sha('a'));
});

test('decide: CONFLICTING moves a PR to sdg:conflict, removing the old lifecycle label first', () => {
  const [row] = only([pr(2, { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', labels: ['sdg:waiting'] })]);
  assert.deepEqual(labelOps(row), ['-sdg:waiting', '+sdg:conflict']);
  assert.equal(row.lifecycle, 'sdg:conflict');
  assert.equal(row.blocker, 'merge conflicts');
});

test('decide: a DIRTY merge state counts as a conflict', () => {
  const [row] = only([pr(2, { mergeable: 'MERGEABLE', mergeStateStatus: 'DIRTY' })]);
  assert.deepEqual(labelOps(row), ['+sdg:conflict']);
});

test('decide: sdg:conflict moves to sdg:waiting once a push clears the conflict', () => {
  const [row] = only([pr(3, { headRefOid: sha('b'), labels: ['sdg:conflict'] })]);
  assert.deepEqual(labelOps(row), ['-sdg:conflict', '+sdg:waiting']);
  assert.equal(row.why, 'the conflict was cleared by a push');
});

test('decide: UNKNOWN mergeability changes no label until GitHub computes it', () => {
  const [row] = only([pr(4, { mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN', labels: ['sdg:waiting'] })]);
  assert.deepEqual(labelOps(row), []);
  assert.equal(row.lifecycle, 'sdg:waiting');
});

test('decide: two lifecycle labels collapse to one', () => {
  const [row] = only([pr(5, { labels: ['sdg:fixing', 'sdg:waiting'] })]);
  assert.deepEqual(labelOps(row), ['-sdg:waiting']);
  assert.equal(row.lifecycle, 'sdg:fixing');
});

test('decide: automation-paused PRs are skipped with no actions at all', () => {
  const [row] = only([pr(6, { mergeable: 'CONFLICTING', labels: [PAUSED] })]);
  assert.equal(row.skip, 'paused');
  assert.deepEqual(row.actions, []);
});

test('decide: fork and non-allowlisted PRs are skipped', () => {
  const rows = only([pr(7, { isCrossRepository: true }), pr(8, { author: 'stranger' })]);
  assert.deepEqual(rows.map(r => [r.number, r.skip, r.actions.length]), [[7, 'fork', 0], [8, 'author', 0]]);
});

test('decide: babysit is a priority hint: those PRs come first and are marked', () => {
  const rows = only([pr(1), pr(2, { labels: ['babysit'] }), pr(3)]);
  assert.deepEqual(rows.map(r => [r.number, r.priority]), [[2, 'babysit'], [1, null], [3, null]]);
  const sticky = rows[0].actions.find(a => a.type === 'comment.upsert').payload.body;
  assert.match(sticky, /Priority:\*\* `babysit`/);
});

test('decide: a human-set needs-human freezes the PR: no label or status changes, sticky only', () => {
  const [row] = only([pr(9, { mergeable: 'CONFLICTING', labels: ['sdg:waiting', NEEDS_HUMAN] })]);
  assert.deepEqual(types(row), ['comment.upsert']);
  assert.match(row.why, /set by a human/);
});

test('decide: needs-human auto-clears when its clearing condition holds', () => {
  const ledger = emptyLedger();
  ledger.escalations['10'] = { reason: 'non-text', active: true, pending: false, headSha: sha('a'), history: [NOW - 1000], clears: [] };
  const [row] = only([pr(10, { labels: ['sdg:conflict', NEEDS_HUMAN] })], ledger);
  assert.deepEqual(labelOps(row), [`-${NEEDS_HUMAN}`, '-sdg:conflict', '+sdg:waiting']);
});

test('decide: needs-human stays while its clearing condition does not hold', () => {
  const ledger = emptyLedger();
  ledger.escalations['10'] = { reason: 'non-text', active: true, pending: false, headSha: sha('a'), history: [NOW], clears: [] };
  const [row] = only([pr(10, { mergeable: 'CONFLICTING', labels: ['sdg:conflict', NEEDS_HUMAN] })], ledger);
  assert.deepEqual(labelOps(row), []);
});

test('decide: needs-human is auto-cleared at most twice in 7 days', () => {
  const ledger = emptyLedger();
  ledger.escalations['10'] = { reason: 'attempts', active: true, pending: false, headSha: sha('a'), history: [NOW], clears: [NOW - 2000, NOW - 1000] };
  const [row] = only([pr(10, { headRefOid: sha('c'), labels: ['sdg:conflict', NEEDS_HUMAN] })], ledger);
  assert.deepEqual(labelOps(row), []);

  ledger.escalations['10'].clears = [NOW - NEEDS_HUMAN_WINDOW_MS - 1, NOW - 1000];
  const [later] = only([pr(10, { headRefOid: sha('c'), labels: ['sdg:conflict', NEEDS_HUMAN] })], ledger);
  assert.deepEqual(labelOps(later).slice(0, 1), [`-${NEEDS_HUMAN}`]);
});

test('decide: policy-denial escalations are never auto-cleared', () => {
  const ledger = emptyLedger();
  ledger.escalations['10'] = { reason: 'policy-denial', active: true, pending: false, headSha: sha('a'), history: [NOW], clears: [] };
  const [row] = only([pr(10, { headRefOid: sha('d'), labels: ['sdg:waiting', NEEDS_HUMAN] })], ledger);
  assert.deepEqual(labelOps(row), []);
});

test('decide: a pending escalation adds needs-human and mentions the owner once in the sticky', () => {
  const ledger = emptyLedger();
  ledger.prs['11'] = { fingerprint: fingerprint(pr(11)), mode: 'act' };
  recordEscalation(ledger.escalations, 11, { reason: 'policy-denial', headSha: sha('a'), now: NOW });
  const [row] = only([pr(11, { labels: ['sdg:waiting'] })], ledger);
  assert.deepEqual(types(row), ['label.add', 'comment.upsert']);
  assert.equal(row.actions[0].payload.label, NEEDS_HUMAN);
  const body = row.actions[1].payload.body;
  assert.match(body, /<!-- sdg:escalation reason=policy-denial clear=a-human-removes-needs-human n=1 -->/);
  assert.match(body, /@iamgerwin this pull request needs a human/);
});

test('decide: an escalation already decided (e.g. only logged in shadow mode) is not planned again every tick', () => {
  const ledger = emptyLedger();
  const escalation = recordEscalation(ledger.escalations, 11, { reason: 'policy-denial', headSha: sha('a'), now: NOW });
  ledger.prs['11'] = { fingerprint: fingerprint(pr(11)), mode: 'shadow', escalationAt: escalation.at };
  const [row] = only([pr(11, { labels: ['sdg:waiting'] })], ledger, { mode: 'shadow' });
  assert.deepEqual(row.actions, []);
  assert.deepEqual(row.pending, [`add label \`${NEEDS_HUMAN}\``]);
});

test('decide: a human removing our needs-human ends the escalation', () => {
  const ledger = emptyLedger();
  ledger.escalations['12'] = { reason: 'attempts', active: true, pending: false, headSha: sha('a'), history: [NOW], clears: [] };
  const [row] = only([pr(12, { labels: ['sdg:waiting'] })], ledger);
  assert.equal(row.humanCleared, true);
});

test('recordEscalation: the third escalation in 7 days sticks as flapping; an active one is not counted twice', () => {
  const escalations = {};
  recordEscalation(escalations, 5, { reason: 'attempts', headSha: 'x', now: NOW - 3000 });
  recordEscalation(escalations, 5, { reason: 'uncertain', headSha: 'x', now: NOW - 2500 });
  assert.equal(escalations['5'].history.length, 1, 'still active: not re-counted');

  escalations['5'].active = false;
  recordEscalation(escalations, 5, { reason: 'uncertain', headSha: 'x', now: NOW - 2000 });
  escalations['5'].active = false;
  const third = recordEscalation(escalations, 5, { reason: 'attempts', headSha: 'x', now: NOW });
  assert.equal(third.reason, 'flapping');
  assert.equal(third.history.length, 3);
});

test('decide: an unchanged fingerprint in the same mode plans nothing; a mode change re-decides', () => {
  const ledger = emptyLedger();
  ledger.prs['1'] = { fingerprint: fingerprint(pr(1)), mode: 'act' };
  assert.deepEqual(only([pr(1)], ledger)[0].actions, []);
  assert.ok(only([pr(1)], ledger, { mode: 'shadow' })[0].actions.length > 0);
});

test('decide: the sticky is only planned when its body hash changed', () => {
  const [first] = only([pr(1, { labels: ['sdg:waiting'], mergePolicy: 'PENDING' })]);
  const body = first.actions.find(a => a.type === 'comment.upsert').payload.body;
  const ledger = emptyLedger();
  ledger.prs['1'] = { stickyHash: sha1(body) };
  const [second] = only([pr(1, { labels: ['sdg:waiting'], mergePolicy: 'PENDING' })], ledger);
  assert.deepEqual(second.actions, []);
});

test('decide: an existing sdg/merge-policy status on the head is never re-posted or overwritten', () => {
  for (const mergePolicy of ['PENDING', 'SUCCESS', 'FAILURE']) {
    const [row] = only([pr(1, { mergePolicy })]);
    assert.ok(!types(row).includes('status.post'), mergePolicy);
  }
});

test('decide: --pr restricts actions to one PR but still reports every row', () => {
  const rows = only([pr(1), pr(2, { mergeable: 'CONFLICTING' })], emptyLedger(), { pr: 2 });
  assert.deepEqual(rows.map(r => [r.number, r.filtered, r.actions.length > 0]), [[1, true, false], [2, false, true]]);
  assert.deepEqual(rows[0].pending, ['add label `sdg:waiting`']);
});

test('decide: a paused dashboard stops everything', () => {
  assert.deepEqual(decide({ paused: true, prs: [pr(1)] }, emptyLedger(), opts()), { paused: true, prs: [] });
});

test('renderSticky never contains a clock or attribution', () => {
  const body = renderSticky(pr(1), { lifecycle: 'sdg:waiting', why: 'x', next: 'y' }, { mode: 'act' });
  assert.ok(body.startsWith(MARKERS.status));
  assert.doesNotMatch(body, /\d{4}-\d{2}-\d{2}T|Claude|Generated with/);
});

// ---- fingerprint ----

test('fingerprint ignores managed labels but sees human labels, pushes, threads and reviews', () => {
  const base = fingerprint(pr(1));
  assert.equal(fingerprint(pr(1, { labels: ['sdg:conflict', 'conflict-resolved', NEEDS_HUMAN] })), base);
  assert.equal(fingerprint(pr(1, { labels: ['sdg:waiting'] })), base);
  assert.notEqual(fingerprint(pr(1, { labels: ['babysit'] })), base);
  assert.notEqual(fingerprint(pr(1, { labels: [PAUSED] })), base);
  assert.notEqual(fingerprint(pr(1, { headRefOid: sha('b') })), base);
  assert.notEqual(fingerprint(pr(1, { mergeable: 'CONFLICTING' })), base);
  assert.notEqual(fingerprint(pr(1, { reviews: [{ id: 'R1' }] })), base);
  const thread = { id: 'T1', isResolved: false, lastCommentId: 'C1' };
  const withThread = fingerprint(pr(1, { reviewThreads: [thread] }));
  assert.notEqual(withThread, base);
  assert.notEqual(fingerprint(pr(1, { reviewThreads: [{ ...thread, lastCommentId: 'C2' }] })), withThread);
});

test('fingerprint is stable across label order and unaffected by our own merge-policy status', () => {
  assert.equal(fingerprint(pr(1, { labels: ['b', 'a'] })), fingerprint(pr(1, { labels: ['a', 'b'] })));
  const node = (contexts) => ({
    number: 1, headRefOid: sha('a'), mergeable: 'MERGEABLE', author: { login: OWNER },
    commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: contexts } } } }] }
  });
  const ci = { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' };
  const ours = { __typename: 'StatusContext', context: MERGE_POLICY_CONTEXT, state: 'PENDING' };
  assert.equal(fingerprint(normalizePullRequest(node([ci, ours]))), fingerprint(normalizePullRequest(node([ci]))));
});

// ---- the tick, against a stateful fake GitHub ----

const WRITE_METHODS = new Set([
  'addLabels', 'removeLabel', 'createComment', 'updateComment', 'create', 'update',
  'createLabel', 'updateLabel', 'createCommitStatus', 'pinIssue', 'resolveReviewThread'
]);

function fakeGitHub({ prs = [], issues = [], login = OWNER } = {}) {
  const state = {
    prs: prs.map(p => ({ labels: [], ...p })),
    issues,
    comments: [],
    statuses: [],
    repoLabels: [],
    nextId: 1000,
    headOverride: null
  };
  const calls = [];
  const log = (name, params) => calls.push({ name, params });
  const notFound = () => Object.assign(new Error('Not Found'), { status: 404 });
  const findIssue = (number) => state.prs.find(p => p.number === number) || state.issues.find(i => i.number === number);

  const node = (p) => ({
    number: p.number,
    isDraft: false,
    isCrossRepository: Boolean(p.isCrossRepository),
    headRefName: `auto-pr/${p.number}`,
    headRefOid: p.headRefOid,
    baseRefName: 'master',
    mergeable: p.mergeable || 'MERGEABLE',
    mergeStateStatus: p.mergeStateStatus || (p.mergeable === 'CONFLICTING' ? 'DIRTY' : 'CLEAN'),
    author: { login: p.author || OWNER },
    labels: { nodes: p.labels.map(name => ({ name })) },
    reviewThreads: { nodes: [] },
    reviews: { nodes: [] },
    commits: {
      nodes: [{
        commit: {
          oid: p.headRefOid,
          statusCheckRollup: {
            contexts: {
              nodes: state.statuses
                .filter(s => s.sha === p.headRefOid)
                .map(s => ({ __typename: 'StatusContext', context: s.context, state: s.state.toUpperCase() }))
            }
          }
        }
      }]
    }
  });

  const octokit = {
    paginate: async (method, params) => (await method(params)).data,
    graphql: async (query, vars) => {
      if (query.includes('pinIssue')) { log('pinIssue', vars); return {}; }
      if (query.includes('resolveReviewThread')) { log('resolveReviewThread', vars); return {}; }
      if (query.includes('pullRequest(number')) {
        log('freshChecks', vars);
        return { repository: { pullRequest: { commits: node(findIssue(vars.number)).commits } } };
      }
      log('snapshot', vars);
      return {
        repository: {
          pausedIssues: {
            nodes: state.issues.filter(i => i.state === 'open' && i.labels.includes(PAUSED)).map(i => ({ number: i.number, body: i.body }))
          },
          pullRequests: { nodes: state.prs.map(node), pageInfo: { hasNextPage: false, endCursor: null } }
        }
      };
    },
    rest: {
      users: { getAuthenticated: async () => ({ data: { login } }) },
      pulls: {
        get: async ({ pull_number }) => {
          log('pulls.get', { pull_number });
          const p = findIssue(pull_number);
          const merge = node(p);
          return {
            data: {
              number: p.number, state: 'open', head: { sha: state.headOverride || p.headRefOid }, labels: p.labels.map(name => ({ name })),
              mergeable: merge.mergeable === 'UNKNOWN' ? null : merge.mergeable === 'MERGEABLE',
              mergeable_state: merge.mergeStateStatus.toLowerCase()
            }
          };
        }
      },
      issues: {
        addLabels: async (params) => {
          log('addLabels', params);
          const issue = findIssue(params.issue_number);
          params.labels.forEach(l => { if (!issue.labels.includes(l)) issue.labels.push(l); });
          return { data: [] };
        },
        removeLabel: async (params) => {
          log('removeLabel', params);
          const issue = findIssue(params.issue_number);
          if (!issue.labels.includes(params.name)) throw notFound();
          issue.labels = issue.labels.filter(l => l !== params.name);
          return { data: [] };
        },
        listComments: async ({ issue_number }) => ({ data: state.comments.filter(c => c.issue_number === issue_number) }),
        getComment: async ({ comment_id }) => {
          const comment = state.comments.find(c => c.id === comment_id);
          if (!comment) throw notFound();
          return { data: comment };
        },
        createComment: async (params) => {
          log('createComment', params);
          const comment = { id: state.nextId++, issue_number: params.issue_number, body: params.body, user: { login } };
          state.comments.push(comment);
          return { data: comment };
        },
        updateComment: async (params) => {
          log('updateComment', params);
          state.comments.find(c => c.id === params.comment_id).body = params.body;
          return { data: {} };
        },
        get: async ({ issue_number }) => {
          const issue = state.issues.find(i => i.number === issue_number);
          if (!issue) throw notFound();
          return { data: issue };
        },
        listForRepo: async (params) => ({
          data: state.issues.filter(i => i.state === params.state && (!params.creator || i.user.login === params.creator))
        }),
        create: async (params) => {
          log('create', params);
          const issue = { number: state.nextId++, node_id: 'I_dash', title: params.title, body: params.body, state: 'open', labels: [], user: { login } };
          state.issues.push(issue);
          return { data: issue };
        },
        update: async (params) => {
          log('update', params);
          state.issues.find(i => i.number === params.issue_number).body = params.body;
          return { data: {} };
        },
        listLabelsForRepo: async () => ({ data: state.repoLabels }),
        createLabel: async (params) => {
          log('createLabel', params);
          state.repoLabels.push({ name: params.name, color: params.color, description: params.description });
          return { data: {} };
        },
        updateLabel: async (params) => { log('updateLabel', params); return { data: {} }; }
      },
      repos: {
        createCommitStatus: async (params) => {
          log('createCommitStatus', params);
          state.statuses.push(params);
          return { data: {} };
        }
      }
    }
  };
  const writes = () => calls.filter(c => WRITE_METHODS.has(c.name));
  return { octokit, state, calls, writes };
}

function makeConfig(prMaint = {}, extra = {}) {
  return {
    repositories: [{ owner: OWNER, repo: 'demo', enabled: true, conflictFixer: null }],
    conflictFixer: { mode: 'allowlist', allowlist: [`${OWNER}/demo`], denylist: [] },
    prMaint: { ...PR_MAINT_DEFAULTS, enabled: true, ...prMaint },
    ...extra
  };
}

function tmpFiles(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-pr-maint-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, ledger: path.join(dir, 'state.json'), decisions: path.join(dir, 'decisions.jsonl') };
}

function makeRunner(fake, files, options = {}) {
  return new PrMaint({
    github: new PrMaintGitHub(fake.octokit),
    ledger: new PrMaintLedger({ filePath: files.ledger }),
    acquireLock: () => ({ acquired: true, release() {} }),
    now: () => NOW,
    decisionsFile: files.decisions,
    ...options
  });
}

const OPEN_PRS = () => [
  { number: 1, headRefOid: sha('1') },
  { number: 2, headRefOid: sha('2'), mergeable: 'CONFLICTING', labels: ['sdg:waiting'] },
  { number: 3, headRefOid: sha('3'), labels: ['babysit'] },
  { number: 4, headRefOid: sha('4'), isCrossRepository: true },
  { number: 5, headRefOid: sha('5'), author: 'stranger' },
  { number: 6, headRefOid: sha('6'), mergeable: 'CONFLICTING', labels: [PAUSED] }
];

const readDecisions = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : []);

test('shadow tick writes only the dashboard issue, and a re-run writes nothing', async (t) => {
  const files = tmpFiles(t);
  const fake = fakeGitHub({ prs: OPEN_PRS() });
  const runner = makeRunner(fake, files);

  const first = await runner.execute(makeConfig());
  assert.equal(first.success, true);
  assert.equal(first.mode, 'shadow');
  assert.deepEqual(fake.writes().map(w => w.name), ['create', 'pinIssue']);
  assert.deepEqual(fake.state.prs.map(p => p.labels), OPEN_PRS().map(p => p.labels || []), 'no PR label touched');
  assert.equal(fake.state.statuses.length, 0);
  assert.equal(fake.state.comments.length, 0);
  assert.ok(!fake.calls.some(c => c.name === 'pulls.get'), 'shadow never needs the head pin');

  const dashboard = fake.state.issues[0];
  assert.ok(dashboard.body.startsWith(MARKERS.dashboard));
  assert.match(dashboard.body, /\| #2 \| `sdg:conflict` \|.*remove label `sdg:waiting`; add label `sdg:conflict` \|/);
  assert.match(dashboard.body, /\| #6 \| skipped \(paused\) \|/);

  const decisions = readDecisions(files.decisions);
  assert.ok(decisions.length > 0);
  assert.ok(decisions.filter(d => d.scope === 'pr').every(d => d.verdict === 'deny' && d.rule === 'mode'));
  assert.ok(!decisions.some(d => [4, 5, 6].includes(d.pr)), 'skipped PRs plan nothing');

  const before = fake.writes().length;
  const second = await runner.execute(makeConfig());
  assert.equal(second.success, true);
  assert.equal(fake.writes().length, before, 're-run made GitHub writes');
  assert.equal(readDecisions(files.decisions).length, decisions.length, 're-run planned actions again');
});

test('act tick labels, posts statuses and stickies, and an idempotent re-run makes zero writes', async (t) => {
  const files = tmpFiles(t);
  const fake = fakeGitHub({ prs: OPEN_PRS() });
  const runner = makeRunner(fake, files);

  const first = await runner.execute(makeConfig({ mode: 'act' }));
  assert.equal(first.success, true);
  assert.equal(getPrMaintExitCode(first), 0);
  assert.deepEqual(fake.state.prs.map(p => [p.number, p.labels]), [
    [1, ['sdg:waiting']],
    [2, ['sdg:conflict']],
    [3, ['babysit', 'sdg:waiting']],
    [4, []],
    [5, []],
    [6, [PAUSED]]
  ]);
  assert.deepEqual(fake.state.statuses.map(s => [s.sha, s.context, s.state]).sort(), [
    [sha('1'), MERGE_POLICY_CONTEXT, 'pending'],
    [sha('2'), MERGE_POLICY_CONTEXT, 'pending'],
    [sha('3'), MERGE_POLICY_CONTEXT, 'pending']
  ]);
  assert.deepEqual(fake.state.comments.map(c => c.issue_number).sort(), [1, 2, 3]);
  assert.equal(fake.state.repoLabels.length, 8);
  // babysit first in the write order
  assert.equal(fake.writes().find(w => w.name === 'addLabels').params.issue_number, 3);

  const before = fake.writes().length;
  await runner.execute(makeConfig({ mode: 'act' }));
  assert.deepEqual(fake.writes().slice(before), [], 're-run made GitHub writes');

  // Losing data/ costs reads, never duplicate writes
  fs.rmSync(files.ledger);
  await runner.execute(makeConfig({ mode: 'act' }));
  assert.deepEqual(fake.writes().slice(before), [], 'run with a lost ledger made GitHub writes');
});

test('a push that clears a conflict moves sdg:conflict to sdg:waiting and updates the sticky in place', async (t) => {
  const files = tmpFiles(t);
  const fake = fakeGitHub({ prs: [{ number: 2, headRefOid: sha('2'), mergeable: 'CONFLICTING' }] });
  const runner = makeRunner(fake, files);
  await runner.execute(makeConfig({ mode: 'act' }));
  assert.deepEqual(fake.state.prs[0].labels, ['sdg:conflict']);

  Object.assign(fake.state.prs[0], { headRefOid: sha('9'), mergeable: 'MERGEABLE' });
  const before = fake.writes().length;
  await runner.execute(makeConfig({ mode: 'act' }));
  assert.deepEqual(fake.state.prs[0].labels, ['sdg:waiting']);
  assert.deepEqual(fake.writes().slice(before).map(w => w.name).sort(),
    ['addLabels', 'createCommitStatus', 'removeLabel', 'update', 'updateComment']);
  assert.equal(fake.state.comments.length, 1, 'the sticky is edited, not duplicated');
});

test('a head that moves before the write is denied and the PR is decided again next tick', async (t) => {
  const files = tmpFiles(t);
  const fake = fakeGitHub({ prs: [{ number: 1, headRefOid: sha('1') }] });
  fake.state.headOverride = sha('f');
  const runner = makeRunner(fake, files);
  const result = await runner.execute(makeConfig({ mode: 'act' }));
  const outcomes = result.results[0].prs[0].outcomes;
  assert.ok(outcomes.every(o => o.status === 'denied' && o.rule === 'head-pin'));
  assert.deepEqual(fake.state.prs[0].labels, []);
  const ledger = JSON.parse(fs.readFileSync(files.ledger, 'utf8'));
  assert.equal(ledger.repos['iamgerwin/demo'].prs['1']?.fingerprint, undefined);
});

test('a dashboard issue labeled automation-paused stops every write', async (t) => {
  const files = tmpFiles(t);
  const fake = fakeGitHub({
    prs: OPEN_PRS(),
    issues: [{ number: 50, state: 'open', labels: [PAUSED], body: `${MARKERS.dashboard}\nold`, user: { login: OWNER } }]
  });
  const result = await makeRunner(fake, files).execute(makeConfig({ mode: 'act' }));
  assert.equal(result.results[0].paused, true);
  assert.deepEqual(fake.writes(), []);
  assert.deepEqual(readDecisions(files.decisions), []);
});

test('dry run decides and reports but writes nothing: no GitHub writes, ledger, or decisions log', async (t) => {
  const files = tmpFiles(t);
  const fake = fakeGitHub({ prs: OPEN_PRS() });
  const result = await makeRunner(fake, files).execute(makeConfig({ mode: 'act' }), { dryRun: true });
  assert.equal(result.dryRun, true);
  const planned = result.results[0].prs.flatMap(p => p.outcomes);
  assert.ok(planned.length > 0);
  assert.ok(planned.every(o => o.status === 'planned'));
  assert.deepEqual(fake.writes(), []);
  assert.ok(!fake.calls.some(c => c.name === 'pulls.get'));
  assert.equal(fs.existsSync(files.ledger), false);
  assert.equal(fs.existsSync(files.decisions), false);
});

test('dry run works while prMaint is disabled; a real tick does not', async (t) => {
  const files = tmpFiles(t);
  const fake = fakeGitHub({ prs: OPEN_PRS() });
  const runner = makeRunner(fake, files);
  const skipped = await runner.execute(makeConfig({ enabled: false }));
  assert.equal(skipped.skipped, true);
  assert.deepEqual(fake.calls, []);
  const dry = await runner.execute(makeConfig({ enabled: false }), { dryRun: true });
  assert.equal(dry.success, true);
  assert.deepEqual(fake.writes(), []);
});

test('repositories outside the conflictFixer allowlist are never read or written', async (t) => {
  const files = tmpFiles(t);
  const fake = fakeGitHub({ prs: OPEN_PRS() });
  const result = await makeRunner(fake, files).execute(makeConfig({ mode: 'act' }, {
    conflictFixer: { mode: 'allowlist', allowlist: [], denylist: [] }
  }));
  assert.deepEqual(result.results.map(r => [r.skipped, r.reason]), [[true, 'not-allowlisted']]);
  assert.deepEqual(fake.calls, []);
});

test('--mode overrides the configured mode and --pr limits writes to that PR', async (t) => {
  const files = tmpFiles(t);
  const fake = fakeGitHub({ prs: OPEN_PRS() });
  const result = await makeRunner(fake, files).execute(makeConfig({ mode: 'shadow' }), { mode: 'act', pr: 2 });
  assert.equal(result.mode, 'act');
  const touched = new Set(fake.writes().map(w => w.params.issue_number).filter(Boolean));
  const dashboardNumber = fake.state.issues[0].number;
  assert.deepEqual([...touched].filter(n => n !== dashboardNumber).sort(), [2]);
});

test('pr-maint holds its own lock, separate from run.lock', async (t) => {
  const files = tmpFiles(t);
  process.env.SDG_RUN_LOCK_FILE = path.join(files.dir, 'run.lock');
  process.env.SDG_PR_MAINT_LOCK_FILE = path.join(files.dir, 'pr-maint.lock');
  t.after(() => {
    delete process.env.SDG_RUN_LOCK_FILE;
    delete process.env.SDG_PR_MAINT_LOCK_FILE;
  });

  const fake = fakeGitHub({ prs: [] });
  const runner = makeRunner(fake, files, { acquireLock: undefined });

  const runLock = acquireRunLock();
  assert.equal(runLock.acquired, true);
  try {
    const result = await runner.execute(makeConfig());
    assert.equal(result.locked, undefined, 'a held run.lock must not block pr-maint');
    assert.equal(result.success, true);
  } finally {
    runLock.release();
  }

  const tickLock = acquireRunLock({ filePath: prMaintLockFile() });
  try {
    const result = await runner.execute(makeConfig());
    assert.equal(result.locked, true);
    assert.match(result.error, /pr-maint tick is already in progress/);
    // And it does not take run.lock either
    const other = acquireRunLock();
    assert.equal(other.acquired, true);
    other.release();
  } finally {
    tickLock.release();
  }
});

test('the default pr-maint lock file is data/pr-maint.lock', () => {
  delete process.env.SDG_PR_MAINT_LOCK_FILE;
  assert.match(prMaintLockFile(), /data[\\/]pr-maint\.lock$/);
});

// ---- review regressions ----

const readLedger = (file) => JSON.parse(fs.readFileSync(file, 'utf8')).repos['iamgerwin/demo'];
const seedLedger = (file, repoEntry, extra = {}) => new PrMaintLedger({ filePath: file }).save({
  breaker: null, writes: [], ...extra, repos: { 'iamgerwin/demo': { prs: {}, escalations: {}, dashboard: {}, labelsVersion: 1, ...repoEntry } }
});

test('decide: a managed label changed by someone else wakes the PR despite an unchanged fingerprint', () => {
  const ledger = emptyLedger();
  ledger.prs['1'] = { fingerprint: fingerprint(pr(1)), mode: 'act', managedLabels: ['sdg:waiting'] };

  // Unchanged: our own last write is what GitHub shows
  assert.deepEqual(only([pr(1, { labels: ['sdg:waiting'], mergePolicy: 'PENDING' })], ledger)[0].actions, []);

  // A second lifecycle label was added
  const [added] = only([pr(1, { labels: ['sdg:fixing', 'sdg:waiting'], mergePolicy: 'PENDING' })], ledger);
  assert.equal(added.changed, true);
  assert.deepEqual(labelOps(added), ['-sdg:waiting']);

  // The lifecycle label was removed: it is repaired
  const [removed] = only([pr(1, { labels: [], mergePolicy: 'PENDING' })], ledger);
  assert.deepEqual(labelOps(removed), ['+sdg:waiting']);

  // A human set needs-human: the sticky explains the freeze
  const [frozen] = only([pr(1, { labels: ['sdg:waiting', NEEDS_HUMAN], mergePolicy: 'PENDING' })], ledger);
  assert.deepEqual(types(frozen), ['comment.upsert']);
  assert.match(frozen.actions[0].payload.body, /set by a human/);
});

test('fingerprint sees mergeStateStatus, so CLEAN to DIRTY under MERGEABLE wakes the PR', () => {
  const ledger = emptyLedger();
  ledger.prs['1'] = { fingerprint: fingerprint(pr(1)), mode: 'act', managedLabels: ['sdg:waiting'] };
  const [row] = only([pr(1, { mergeStateStatus: 'DIRTY', labels: ['sdg:waiting'], mergePolicy: 'PENDING' })], ledger);
  assert.equal(row.changed, true);
  assert.deepEqual(labelOps(row), ['-sdg:waiting', '+sdg:conflict']);
});

test('act ticks: our own label writes do not wake the PR, an external managed-label change is reconciled', async (t) => {
  const files = tmpFiles(t);
  const fake = fakeGitHub({ prs: [{ number: 1, headRefOid: sha('1') }] });
  const runner = makeRunner(fake, files);
  await runner.execute(makeConfig({ mode: 'act' }));
  assert.deepEqual(fake.state.prs[0].labels, ['sdg:waiting']);
  assert.deepEqual(readLedger(files.ledger).prs['1'].managedLabels, ['sdg:waiting']);

  let before = fake.writes().length;
  await runner.execute(makeConfig({ mode: 'act' }));
  assert.deepEqual(fake.writes().slice(before), [], 'our own writes woke the PR');

  fake.state.prs[0].labels.push('sdg:fixing');
  before = fake.writes().length;
  await runner.execute(makeConfig({ mode: 'act' }));
  assert.deepEqual(fake.state.prs[0].labels, ['sdg:fixing']);
  assert.deepEqual(fake.writes().slice(before).filter(w => w.name === 'removeLabel').map(w => w.params.name), ['sdg:waiting']);

  fake.state.prs[0].labels = [];
  await runner.execute(makeConfig({ mode: 'act' }));
  assert.deepEqual(fake.state.prs[0].labels, ['sdg:waiting'], 'a removed lifecycle label is repaired');
});

test('decide: UNKNOWN mergeability never clears a non-text or lockfile escalation', () => {
  for (const reason of ['non-text', 'lockfile']) {
    for (const merge of [
      { mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' },
      { mergeable: 'MERGEABLE', mergeStateStatus: 'UNKNOWN' },
      { mergeable: undefined, mergeStateStatus: undefined }
    ]) {
      const ledger = emptyLedger();
      ledger.escalations['10'] = { reason, active: true, pending: false, headSha: sha('a'), history: [NOW], clears: [] };
      const [row] = only([pr(10, { ...merge, labels: ['sdg:conflict', NEEDS_HUMAN] })], ledger);
      assert.deepEqual(labelOps(row), [], `${reason} ${JSON.stringify(merge)}`);
      assert.match(row.blocker, /needs-human/);
    }
  }
});

test('a planned needs-human clear is denied when the live mergeability is UNKNOWN', async (t) => {
  const files = tmpFiles(t);
  const fake = fakeGitHub({ prs: [{ number: 10, headRefOid: sha('a'), labels: ['sdg:conflict', NEEDS_HUMAN] }] });
  seedLedger(files.ledger, {
    escalations: { 10: { reason: 'non-text', active: true, pending: false, headSha: sha('a'), history: [NOW], clears: [] } }
  });
  const runner = makeRunner(fake, files);
  // The snapshot is clean, but GitHub recomputes mergeability before the write
  const get = fake.octokit.rest.pulls.get;
  fake.octokit.rest.pulls.get = async (params) => {
    const res = await get(params);
    return { data: { ...res.data, mergeable: null, mergeable_state: 'unknown' } };
  };
  const result = await runner.execute(makeConfig({ mode: 'act' }));
  const clear = result.results[0].prs[0].outcomes.find(o => o.label === NEEDS_HUMAN);
  assert.equal(clear.status, 'denied');
  assert.equal(clear.rule, 'needs-human');
  assert.ok(fake.state.prs[0].labels.includes(NEEDS_HUMAN));
  assert.equal(readLedger(files.ledger).escalations['10'].active, true);
});

test('label setup is admitted under the hourly cap, and a setup cut short is not marked done', async (t) => {
  const files = tmpFiles(t);
  const fake = fakeGitHub({ prs: [] });
  const runner = makeRunner(fake, files);
  const result = await runner.execute(makeConfig({ mode: 'act', rateLimits: { writesPerPrPerTick: 20, writesPerHour: 1 } }));

  assert.equal(fake.writes().filter(w => w.name === 'createLabel').length, 1);
  const state = JSON.parse(fs.readFileSync(files.ledger, 'utf8'));
  assert.equal(state.writes.length, 1);
  assert.equal(state.breaker, null, 'the hourly cap paces setup, it does not trip the breaker');
  assert.equal(state.repos['iamgerwin/demo'].labelsVersion, undefined, 'setup cut short is not marked done');
  const setup = readDecisions(files.decisions).filter(d => d.type === 'setup');
  assert.deepEqual(setup.map(d => d.verdict), ['allow', 'deny']);
  // The hour's one write went to setup: the dashboard waits, and that fails the tick
  assert.equal(result.results[0].dashboard, 'denied');
  assert.equal(getPrMaintExitCode(result), 1);
});

test('writesPerHour 1 without a dashboard: setup completes across ticks, then the dashboard is created, breaker never trips', async (t) => {
  const files = tmpFiles(t);
  const fake = fakeGitHub({ prs: [] });
  let now = NOW;
  const runner = makeRunner(fake, files, { now: () => now });
  const cfg = makeConfig({ mode: 'act', rateLimits: { writesPerPrPerTick: 20, writesPerHour: 1 } });

  let result;
  for (let tick = 0; tick < 20 && !fake.state.issues.length; tick++) {
    result = await runner.execute(cfg);
    const state = JSON.parse(fs.readFileSync(files.ledger, 'utf8'));
    assert.equal(state.breaker, null, `breaker tripped on tick ${tick}`);
    assert.equal(result.mode, 'act');
    now += 61 * 60 * 1000;
  }
  assert.equal(fake.state.repoLabels.length, 8, 'every label was created');
  assert.equal(readLedger(files.ledger).labelsVersion, 1);
  assert.equal(fake.state.issues.length, 1, 'the dashboard was created');
  assert.equal(result.results[0].dashboard, 'done');
  assert.equal(getPrMaintExitCode(result), 0);
  // Pinning would be a second write the hourly cap can never fit
  assert.ok(!fake.calls.some(c => c.name === 'pinIssue'));
  assert.equal(readLedger(files.ledger).dashboard.number, fake.state.issues[0].number);
});

test('a needs-human clear denied for live UNKNOWN mergeability is retried and succeeds on the next clean tick', async (t) => {
  const files = tmpFiles(t);
  const fake = fakeGitHub({ prs: [{ number: 10, headRefOid: sha('a'), labels: ['sdg:conflict', NEEDS_HUMAN] }] });
  seedLedger(files.ledger, {
    escalations: { 10: { reason: 'non-text', active: true, pending: false, headSha: sha('a'), history: [NOW], clears: [] } }
  });
  const runner = makeRunner(fake, files);
  const get = fake.octokit.rest.pulls.get;
  fake.octokit.rest.pulls.get = async (params) => {
    const res = await get(params);
    return { data: { ...res.data, mergeable: null, mergeable_state: 'unknown' } };
  };
  const first = await runner.execute(makeConfig({ mode: 'act' }));
  const outcomes = first.results[0].prs[0].outcomes;
  assert.deepEqual(outcomes.map(o => [o.label, o.status, o.rule]), [[NEEDS_HUMAN, 'denied', 'needs-human']],
    'nothing after the denied clear is written');
  assert.deepEqual(fake.state.comments, [], 'no un-escalated sticky while needs-human stays');
  assert.equal(readLedger(files.ledger).prs['10']?.fingerprint, undefined, 'the denial is not cached as settled');

  // GitHub has computed mergeability again; nothing else changed
  fake.octokit.rest.pulls.get = get;
  await runner.execute(makeConfig({ mode: 'act' }));
  assert.deepEqual(fake.state.prs[0].labels, ['sdg:waiting']);
  assert.equal(readLedger(files.ledger).escalations['10'].active, false);
  assert.equal(fake.state.comments.length, 1);
  assert.doesNotMatch(fake.state.comments[0].body, /Escalated/);
});

test('renderDashboard keeps an escalated babysit PR within the bound ahead of 50 older skipped forks', () => {
  const ledger = emptyLedger();
  ledger.escalations['51'] = { reason: 'policy-denial', active: true, pending: false, headSha: sha('a'), history: [NOW], clears: [] };
  const prs = [
    ...Array.from({ length: 50 }, (_, i) => pr(i + 1, { isCrossRepository: true })),
    pr(51, { labels: ['babysit', 'sdg:waiting', NEEDS_HUMAN] })
  ];
  const rows = decide({ prs }, ledger, opts()).prs;
  const body = renderDashboard(rows, { mode: 'act', configuredMode: 'act', now: NOW, repo: 'iamgerwin/demo' });
  const listed = body.split('\n').filter(l => l.startsWith('| #'));
  assert.equal(listed.length, MAX_DASHBOARD_ROWS);
  assert.match(listed[0], /^\| #51 \|.*needs-human/);
  assert.ok(listed.slice(1).every(l => /skipped \(fork\)/.test(l)));
  assert.ok(listed.slice(1).map(l => Number(l.match(/#(\d+)/)[1])).every((n, i, all) => i === 0 || all[i - 1] < n), 'by number within a tier');
  assert.match(body, /1 more pull request not listed \(the dashboard is capped\): https:\/\/github\.com\/iamgerwin\/demo\/pulls/);
});

test('label setup makes no write when the hourly budget is already spent', async (t) => {
  const files = tmpFiles(t);
  const fake = fakeGitHub({ prs: [] });
  new PrMaintLedger({ filePath: files.ledger }).save({ breaker: null, writes: Array(5).fill(NOW - 1000), repos: {} });
  await makeRunner(fake, files).execute(makeConfig({ mode: 'act', rateLimits: { writesPerPrPerTick: 20, writesPerHour: 5 } }));
  assert.deepEqual(fake.writes(), []);
});

test('renderDashboard is bounded in rows and UTF-8 bytes, with an omitted count and link', () => {
  const rows = Array.from({ length: 300 }, (_, i) => ({
    number: i + 1, lifecycle: 'sdg:conflict', next: 'resolve the conflicts — ünïcödé ✓'.repeat(2), blocker: 'merge conflicts',
    pending: ['remove label `sdg:waiting`', 'add label `sdg:conflict`']
  }));
  const body = renderDashboard(rows, { mode: 'shadow', configuredMode: 'shadow', now: NOW, repo: 'iamgerwin/demo' });
  assert.ok(Buffer.byteLength(body, 'utf8') <= MAX_TEXT_BYTES, `${Buffer.byteLength(body, 'utf8')} bytes`);
  const listed = body.split('\n').filter(l => l.startsWith('| #')).length;
  assert.ok(listed > 0 && listed <= MAX_DASHBOARD_ROWS);
  assert.ok(body.includes(`${300 - listed} more pull requests not listed (the dashboard is capped): https://github.com/iamgerwin/demo/pulls`));
  assert.ok(body.trimEnd().endsWith('to pause all automation.'));

  const few = renderDashboard(rows.slice(0, 3), { mode: 'shadow', configuredMode: 'shadow', now: NOW });
  assert.doesNotMatch(few, /not listed/);
});

test('shadow tick with many open PRs still publishes the dashboard within the text policy', async (t) => {
  const files = tmpFiles(t);
  const fake = fakeGitHub({ prs: Array.from({ length: 120 }, (_, i) => ({ number: i + 1, headRefOid: sha('a') })) });
  const result = await makeRunner(fake, files).execute(makeConfig());
  assert.equal(result.results[0].dashboard, 'done');
  assert.equal(getPrMaintExitCode(result), 0);
  const body = fake.state.issues[0].body;
  assert.ok(Buffer.byteLength(body, 'utf8') <= MAX_TEXT_BYTES);
  assert.match(body, /more pull requests not listed/);
});

test('a dashboard the policy refuses is surfaced: failed tick, error log, decisions record', async (t) => {
  const files = tmpFiles(t);
  const fake = fakeGitHub({ prs: [] });
  // A breaker reason quoting a mention would be stripped; force a refusal via the hourly cap
  new PrMaintLedger({ filePath: files.ledger }).save({ breaker: null, writes: Array(200).fill(NOW - 1000), repos: {} });
  const result = await makeRunner(fake, files).execute(makeConfig());
  assert.equal(result.results[0].dashboard, 'denied');
  assert.match(result.results[0].dashboardError, /^rate: /);
  assert.equal(result.summary.failed, 1);
  assert.equal(getPrMaintExitCode(result), 1);
  const record = readDecisions(files.decisions).find(d => d.type === 'dashboard.publish');
  assert.match(record.reason, /dashboard not published: rate/);
});

test('the dashboard is recovered when it was closed, deleted or edited on GitHub', async (t) => {
  const files = tmpFiles(t);
  const fake = fakeGitHub({ prs: [{ number: 1, headRefOid: sha('1') }] });
  const runner = makeRunner(fake, files);
  await runner.execute(makeConfig());
  const first = fake.state.issues[0];
  const body = first.body;

  // Unchanged and intact: a read, no write
  let before = fake.writes().length;
  assert.equal((await runner.execute(makeConfig())).results[0].dashboard, 'unchanged');
  assert.deepEqual(fake.writes().slice(before), []);

  // Edited by someone: repaired in place
  first.body = `${MARKERS.dashboard}\nvandalized`;
  before = fake.writes().length;
  await runner.execute(makeConfig());
  assert.deepEqual(fake.writes().slice(before).map(w => w.name), ['update']);
  assert.equal(first.body, body);

  // Closed: a new one is opened
  first.state = 'closed';
  await runner.execute(makeConfig());
  const second = fake.state.issues.find(i => i.state === 'open');
  assert.ok(second && second.number !== first.number);
  assert.equal(readLedger(files.ledger).dashboard.number, second.number);

  // Deleted: recreated
  fake.state.issues = fake.state.issues.filter(i => i !== second);
  await runner.execute(makeConfig());
  assert.equal(fake.state.issues.filter(i => i.state === 'open').length, 1);
  assert.equal(fake.state.issues.find(i => i.state === 'open').body, body);
});

test('decide: a pending escalation whose needs-human is already on GitHub is acknowledged', () => {
  const ledger = emptyLedger();
  recordEscalation(ledger.escalations, 11, { reason: 'policy-denial', headSha: sha('a'), now: NOW });
  const [row] = only([pr(11, { labels: ['sdg:waiting', NEEDS_HUMAN] })], ledger);
  assert.equal(row.delivered, true);
  assert.equal(row.escalation.pending, false);
  assert.deepEqual(labelOps(row), []);
  assert.equal(ledger.escalations['11'].pending, true, 'decide stays pure');
});

test('crash after the needs-human add: recovery acknowledges it, and a later human clear is honored', async (t) => {
  const files = tmpFiles(t);
  // GitHub has the label, the ledger (saved before the crash) still says pending
  const fake = fakeGitHub({ prs: [{ number: 11, headRefOid: sha('a'), labels: ['sdg:waiting', NEEDS_HUMAN] }] });
  seedLedger(files.ledger, {
    escalations: { 11: { reason: 'policy-denial', detail: null, headSha: sha('a'), at: NOW - 5000, active: true, pending: true, history: [NOW - 5000], clears: [] } }
  });
  const runner = makeRunner(fake, files);
  await runner.execute(makeConfig({ mode: 'act' }));
  assert.equal(readLedger(files.ledger).escalations['11'].pending, false);

  // A human removes needs-human and pushes
  fake.state.prs[0].labels = ['sdg:waiting'];
  fake.state.prs[0].headRefOid = sha('b');
  const before = fake.writes().length;
  await runner.execute(makeConfig({ mode: 'act' }));
  assert.ok(!fake.state.prs[0].labels.includes(NEEDS_HUMAN), 'needs-human was re-added over the human clear');
  assert.ok(!fake.writes().slice(before).some(w => w.name === 'addLabels' && w.params.labels.includes(NEEDS_HUMAN)));
  assert.equal(readLedger(files.ledger).escalations['11'].active, false);
});

test('renderDashboard shows mode, budget and breaker, and never mentions anyone', () => {
  const body = renderDashboard([], {
    mode: 'shadow',
    configuredMode: 'act',
    breaker: { until: NOW + 1000, reason: 'text-format: text mentions @someone' },
    caps: { writesPerPrPerTick: 20, writesPerHour: 200 },
    now: NOW
  });
  assert.match(body, /\*\*Mode:\*\* `shadow` \(configured `act`\)/);
  assert.match(body, /20 writes per PR per tick, 200 writes per hour/);
  assert.match(body, /tripped until 2026-10-17T12:00:01.000Z/);
  assert.doesNotMatch(body, /@/);
});
