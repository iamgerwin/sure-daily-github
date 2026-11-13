import test from 'node:test';
import assert from 'node:assert/strict';
import { PrMaintGitHub, LABEL_DEFINITIONS, MAX_THREAD_PAGES, DASHBOARD_TITLE, rollupState, mergePolicyState } from '../src/github/pr-labels.js';
import { MARKERS, MERGE_POLICY_CONTEXT, PAUSED } from '../src/core/policy.js';
import { decide } from '../src/core/pr-maint.js';

const OWNER = 'iamgerwin';

// Records every call; `responses` overrides individual methods
function stubOctokit(responses = {}) {
  const calls = [];
  const method = (name, fallback) => async (params) => {
    calls.push({ name, params });
    return (responses[name] || fallback)(params);
  };
  const octokit = {
    paginate: async (fn, params) => (await fn(params)).data,
    graphql: async (query, variables) => {
      calls.push({ name: 'graphql', query, params: variables });
      return (responses.graphql || (() => ({})))(variables);
    },
    rest: {
      users: { getAuthenticated: method('getAuthenticated', () => ({ data: { login: OWNER } })) },
      issues: {
        listLabelsForRepo: method('listLabelsForRepo', () => ({ data: [] })),
        createLabel: method('createLabel', () => ({ data: {} })),
        updateLabel: method('updateLabel', () => ({ data: {} })),
        addLabels: method('addLabels', () => ({ data: [] })),
        removeLabel: method('removeLabel', () => ({ data: [] })),
        listComments: method('listComments', () => ({ data: [] })),
        getComment: method('getComment', () => { throw Object.assign(new Error('Not Found'), { status: 404 }); }),
        createComment: method('createComment', (p) => ({ data: { id: 5, ...p } })),
        updateComment: method('updateComment', () => ({ data: {} })),
        get: method('get', () => { throw Object.assign(new Error('Not Found'), { status: 404 }); }),
        listForRepo: method('listForRepo', () => ({ data: [] })),
        create: method('create', (p) => ({ data: { number: 77, node_id: 'I_77', ...p } })),
        update: method('update', () => ({ data: {} }))
      },
      repos: { createCommitStatus: method('createCommitStatus', () => ({ data: {} })) }
    }
  };
  return { octokit, calls };
}

async function client(responses) {
  const stub = stubOctokit(responses);
  const github = new PrMaintGitHub(stub.octokit);
  await github.whoami();
  stub.calls.length = 0;
  return { github, calls: stub.calls };
}

const names = (calls) => calls.map(c => c.name);

test('ensureLabels creates missing labels, repairs drifted managed ones, and leaves human labels alone', async () => {
  const existing = [
    { name: 'sdg:conflict', color: 'ffffff', description: 'old' },
    { name: 'babysit', color: 'abcdef', description: 'my own colour' },
    ...LABEL_DEFINITIONS.filter(l => !['sdg:conflict', 'babysit'].includes(l.name))
  ];
  const { github, calls } = await client({ listLabelsForRepo: () => ({ data: existing }) });
  const { written } = await github.ensureLabels(OWNER, 'demo');
  assert.equal(written, 1);
  assert.deepEqual(calls.filter(c => c.name !== 'listLabelsForRepo').map(c => [c.name, c.params.name]), [['updateLabel', 'sdg:conflict']]);
});

test('ensureLabels creates all eight labels on an empty repository, then is a no-op', async () => {
  const created = [];
  const { github, calls } = await client({
    listLabelsForRepo: () => ({ data: created }),
    createLabel: (p) => { created.push(p); return { data: {} }; }
  });
  assert.equal((await github.ensureLabels(OWNER, 'demo')).written, 8);
  assert.deepEqual(created.map(l => l.name), [
    'sdg:conflict', 'sdg:fixing', 'sdg:waiting', 'sdg:ready', 'conflict-resolved', 'needs-human', 'babysit', PAUSED
  ]);
  assert.ok(created.every(l => /^[0-9a-f]{6}$/.test(l.color) && l.description.length <= 100));
  calls.length = 0;
  assert.equal((await github.ensureLabels(OWNER, 'demo')).written, 0);
  assert.deepEqual(names(calls), ['listLabelsForRepo']);
});

test('ensureLabels stops at the first write its admission refuses and reports it incomplete', async () => {
  const { github, calls } = await client();
  const admitted = [];
  const result = await github.ensureLabels(OWNER, 'demo', {
    write: async (what, fn) => {
      if (admitted.length === 2) return false;
      admitted.push(what);
      await fn();
      return true;
    }
  });
  assert.deepEqual(result, { written: 2, complete: false });
  assert.deepEqual(admitted, ['create label sdg:conflict', 'create label sdg:fixing']);
  assert.equal(calls.filter(c => c.name === 'createLabel').length, 2);
});

test('freshPullRequest reports mergeability, UNKNOWN until GitHub computed it', async () => {
  const pr = (extra) => ({ data: { number: 3, state: 'open', head: { sha: 'h1' }, labels: [], ...extra } });
  let data = pr({ mergeable: true, mergeable_state: 'clean' });
  const stub = stubOctokit();
  stub.octokit.rest.pulls = { get: async () => data };
  const github = new PrMaintGitHub(stub.octokit);
  assert.deepEqual((({ mergeable, mergeStateStatus }) => ({ mergeable, mergeStateStatus }))(await github.freshPullRequest(OWNER, 'demo', 3)),
    { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' });
  data = pr({ mergeable: null, mergeable_state: 'unknown' });
  assert.equal((await github.freshPullRequest(OWNER, 'demo', 3)).mergeable, 'UNKNOWN');
  data = pr({ mergeable: false, mergeable_state: 'dirty' });
  assert.equal((await github.freshPullRequest(OWNER, 'demo', 3)).mergeStateStatus, 'DIRTY');
});

test('freshPullRequest reads live checks on request, failing closed when they belong to another head', async () => {
  const contexts = [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }];
  let oid = 'h1';
  const stub = stubOctokit({
    graphql: () => ({ repository: { pullRequest: { commits: { nodes: [{ commit: { oid, statusCheckRollup: { contexts: { nodes: contexts } } } }] } } } })
  });
  stub.octokit.rest.pulls = { get: async () => ({ data: { number: 3, state: 'open', head: { sha: 'h1' }, labels: [], mergeable: true, mergeable_state: 'clean' } }) };
  const github = new PrMaintGitHub(stub.octokit);
  assert.equal((await github.freshPullRequest(OWNER, 'demo', 3)).checks, undefined);
  assert.equal(stub.calls.length, 0, 'no checks read unless asked');
  assert.equal((await github.freshPullRequest(OWNER, 'demo', 3, { checks: true })).checks, 'SUCCESS');
  oid = 'h0';
  assert.equal((await github.freshPullRequest(OWNER, 'demo', 3, { checks: true })).checks, null);
});

test('readDashboard returns null for a deleted, closed, or foreign issue', async () => {
  const issue = { number: 77, state: 'open', body: `${MARKERS.dashboard}\nx`, user: { login: OWNER } };
  let respond = () => ({ data: issue });
  const { github } = await client({ get: () => respond() });
  assert.equal((await github.readDashboard(OWNER, 'demo', 77)).number, 77);
  assert.equal(await github.readDashboard(OWNER, 'demo', null), null);
  respond = () => { throw Object.assign(new Error('Gone'), { status: 410 }); };
  assert.equal(await github.readDashboard(OWNER, 'demo', 77), null);
  respond = () => ({ data: { ...issue, state: 'closed' } });
  assert.equal(await github.readDashboard(OWNER, 'demo', 77), null);
  respond = () => ({ data: { ...issue, body: 'marker removed' } });
  assert.equal(await github.readDashboard(OWNER, 'demo', 77), null);
  respond = () => ({ data: { ...issue, user: { login: 'mallory' } } });
  assert.equal(await github.readDashboard(OWNER, 'demo', 77), null);
  respond = () => { throw Object.assign(new Error('boom'), { status: 500 }); };
  await assert.rejects(github.readDashboard(OWNER, 'demo', 77), /boom/);
});

test('upsertSticky creates the comment once, skips an identical body, and edits a changed one', async () => {
  const comments = [];
  const { github, calls } = await client({
    listComments: () => ({ data: comments }),
    createComment: (p) => { const c = { id: 9, body: p.body, user: { login: OWNER } }; comments.push(c); return { data: c }; },
    updateComment: (p) => { comments[0].body = p.body; return { data: {} }; }
  });
  const body = `${MARKERS.status}\nwaiting`;
  assert.deepEqual(await github.upsertSticky(OWNER, 'demo', 1, body), { written: 1, id: 9 });
  assert.deepEqual(await github.upsertSticky(OWNER, 'demo', 1, body), { written: 0, id: 9 });
  assert.deepEqual(await github.upsertSticky(OWNER, 'demo', 1, `${body}!`), { written: 1, id: 9 });
  assert.deepEqual(names(calls).filter(n => n !== 'listComments'), ['createComment', 'updateComment']);
});

test('upsertSticky ignores a marker pasted by someone else', async () => {
  const { github, calls } = await client({
    listComments: () => ({ data: [{ id: 3, body: `${MARKERS.status}\nfake`, user: { login: 'mallory' } }] })
  });
  await github.upsertSticky(OWNER, 'demo', 1, `${MARKERS.status}\nreal`);
  assert.deepEqual(names(calls), ['listComments', 'createComment']);
});

test('upsertSticky uses the cached comment id without listing comments', async () => {
  const body = `${MARKERS.status}\nsame`;
  const { github, calls } = await client({ getComment: () => ({ data: { id: 4, body, user: { login: OWNER } } }) });
  assert.deepEqual(await github.upsertSticky(OWNER, 'demo', 1, body, { commentId: 4 }), { written: 0, id: 4 });
  assert.deepEqual(names(calls), ['getComment']);
});

test('upsertDashboard creates and pins the issue once, then edits only on change', async () => {
  const issues = [];
  const { github, calls } = await client({
    listForRepo: () => ({ data: issues }),
    create: (p) => { const i = { number: 77, node_id: 'I_77', state: 'open', body: p.body, title: p.title, user: { login: OWNER } }; issues.push(i); return { data: i }; },
    update: (p) => { issues[0].body = p.body; return { data: {} }; },
    get: () => ({ data: issues[0] })
  });
  const body = `${MARKERS.dashboard}\nv1`;
  assert.deepEqual(await github.upsertDashboard(OWNER, 'demo', body), { written: 2, number: 77 });
  const create = calls.find(c => c.name === 'create');
  assert.equal(create.params.title, DASHBOARD_TITLE);
  assert.deepEqual(calls.find(c => c.name === 'graphql').params, { issueId: 'I_77' });

  calls.length = 0;
  assert.deepEqual(await github.upsertDashboard(OWNER, 'demo', body, { number: 77 }), { written: 0, number: 77 });
  assert.deepEqual(names(calls), ['get']);
  assert.deepEqual(await github.upsertDashboard(OWNER, 'demo', `${body}2`, { number: 77 }), { written: 1, number: 77 });
});

test('upsertDashboard keeps the new issue when pinning fails', async () => {
  const { github } = await client({ graphql: () => { throw new Error('pin limit reached'); } });
  assert.deepEqual(await github.upsertDashboard(OWNER, 'demo', `${MARKERS.dashboard}\nx`), { written: 1, number: 77 });
});

test('postStatus posts the sdg/merge-policy context on the given sha', async () => {
  const { github, calls } = await client();
  await github.postStatus(OWNER, 'demo', 'abc', { state: 'pending', description: 'Merge policy not evaluated yet' });
  assert.deepEqual(calls[0].params, {
    owner: OWNER, repo: 'demo', sha: 'abc', state: 'pending', context: MERGE_POLICY_CONTEXT, description: 'Merge policy not evaluated yet'
  });
});

test('removeLabel treats a label that is already gone as no write', async () => {
  const { github } = await client({ removeLabel: () => { throw Object.assign(new Error('Not Found'), { status: 404 }); } });
  assert.deepEqual(await github.removeLabel(OWNER, 'demo', 1, 'sdg:waiting'), { written: 0 });
});

test('fetchSnapshot normalizes every page and detects a paused dashboard', async () => {
  const page = (numbers, next) => ({
    repository: {
      pausedIssues: { nodes: [{ number: 3, body: `${MARKERS.dashboard}\n` }] },
      pullRequests: {
        nodes: numbers.map(number => ({
          number,
          headRefOid: 'a'.repeat(40),
          mergeable: 'MERGEABLE',
          author: { login: OWNER },
          labels: { nodes: [{ name: 'babysit' }] },
          reviewThreads: { nodes: [{ id: 'T1', isResolved: false, opener: { nodes: [{ author: { login: 'coderabbitai' } }] }, latest: { nodes: [{ id: 'C9' }] } }] },
          reviews: { nodes: [{ id: 'R1', state: 'COMMENTED', author: { login: 'coderabbitai' } }] }
        })),
        pageInfo: { hasNextPage: Boolean(next), endCursor: next }
      }
    }
  });
  let n = 0;
  const { github, calls } = await client({ graphql: () => (n++ === 0 ? page([2], 'c1') : page([1], null)) });
  const snapshot = await github.fetchSnapshot(OWNER, 'demo');
  assert.equal(snapshot.paused, true);
  assert.deepEqual(snapshot.prs.map(p => p.number), [1, 2]);
  assert.deepEqual(snapshot.prs[0].reviewThreads, [{ id: 'T1', isResolved: false, author: 'coderabbitai', lastCommentId: 'C9' }]);
  assert.deepEqual(calls.map(c => c.params.cursor), [null, 'c1']);
});

test('fetchSnapshot reads every review thread of a PR with more than one page of them', async () => {
  const thread = (id, isResolved) => ({ id, isResolved, opener: { nodes: [{ author: { login: 'coderabbitai' } }] }, latest: { nodes: [{ id: `C${id}` }] } });
  const pull = (number, reviewThreads) => ({
    number, headRefOid: 'a'.repeat(40), mergeable: 'MERGEABLE', author: { login: OWNER },
    labels: { nodes: [] }, reviewThreads, reviews: { nodes: [] }
  });
  const snapshotPage = {
    repository: {
      pausedIssues: { nodes: [] },
      pullRequests: {
        nodes: [
          pull(1, { nodes: [thread('T1', true)], pageInfo: { hasNextPage: true, endCursor: 't1' } }),
          pull(2, { nodes: [thread('T9', false)], pageInfo: { hasNextPage: false, endCursor: 'x' } })
        ],
        pageInfo: { hasNextPage: false, endCursor: null }
      }
    }
  };
  const threadPages = {
    t1: { nodes: [thread('T2', true)], pageInfo: { hasNextPage: true, endCursor: 't2' } },
    t2: { nodes: [thread('T3', false)], pageInfo: { hasNextPage: false, endCursor: 't3' } }
  };
  const { github, calls } = await client({
    graphql: (vars) => (vars.number === undefined
      ? snapshotPage
      : { repository: { pullRequest: { reviewThreads: threadPages[vars.cursor] } } })
  });

  const snapshot = await github.fetchSnapshot(OWNER, 'demo');
  // The unresolved thread on the third page is seen
  assert.deepEqual(snapshot.prs[0].reviewThreads.map(t => [t.id, t.isResolved, t.lastCommentId]),
    [['T1', true, 'CT1'], ['T2', true, 'CT2'], ['T3', false, 'CT3']]);
  assert.deepEqual(snapshot.prs[1].reviewThreads.map(t => t.id), ['T9']);
  // Only the PR with more threads costs extra queries, one per further page
  assert.deepEqual(calls.map(c => c.params), [
    { owner: OWNER, repo: 'demo', cursor: null },
    { owner: OWNER, repo: 'demo', number: 1, cursor: 't1' },
    { owner: OWNER, repo: 'demo', number: 1, cursor: 't2' }
  ]);
});

test('fetchSnapshot marks the thread list incomplete when the PR disappears between pages', async () => {
  const node = {
    number: 4, headRefOid: 'a'.repeat(40), mergeable: 'MERGEABLE', author: { login: OWNER },
    labels: { nodes: [] }, reviews: { nodes: [] },
    reviewThreads: { nodes: [{ id: 'T1', isResolved: false }], pageInfo: { hasNextPage: true, endCursor: 't1' } }
  };
  const { github } = await client({
    graphql: (vars) => (vars.number === undefined
      ? { repository: { pausedIssues: { nodes: [] }, pullRequests: { nodes: [node], pageInfo: { hasNextPage: false } } } }
      : { repository: { pullRequest: null } })
  });
  const snapshot = await github.fetchSnapshot(OWNER, 'demo');
  assert.deepEqual(snapshot.prs[0].reviewThreads.map(t => t.id), ['T1']);
  assert.equal(snapshot.prs[0].threadsIncomplete, true);
  // A partial list is never judged: no label, sticky, status or thread write
  const [row] = decide(snapshot, { prs: {}, escalations: {} }, { mode: 'act', authors: [OWNER], owner: OWNER, now: Date.now(), pr: null }).prs;
  assert.equal(row.skip, 'threads');
  assert.deepEqual(row.actions, []);
});

test('fetchSnapshot stops on a repeated thread cursor and on the page cap, marking the list incomplete', async () => {
  const node = (number) => ({
    number, headRefOid: 'a'.repeat(40), mergeable: 'MERGEABLE', author: { login: OWNER },
    labels: { nodes: [] }, reviews: { nodes: [] },
    reviewThreads: { nodes: [{ id: `T${number}-0`, isResolved: true }], pageInfo: { hasNextPage: true, endCursor: 'c0' } }
  });
  const { github, calls } = await client({
    graphql: (vars) => {
      if (vars.number === undefined) {
        return { repository: { pausedIssues: { nodes: [] }, pullRequests: { nodes: [node(1), node(2)], pageInfo: { hasNextPage: false } } } };
      }
      // #1 always answers the same cursor; #2 always has a fresh next page
      const n = calls.filter(c => c.params.number === vars.number).length;
      const endCursor = vars.number === 1 ? 'c0' : `c${n}`;
      return { repository: { pullRequest: { reviewThreads: { nodes: [{ id: `T${vars.number}-${n}`, isResolved: true }], pageInfo: { hasNextPage: true, endCursor } } } } };
    }
  });
  const snapshot = await github.fetchSnapshot(OWNER, 'demo');
  assert.equal(calls.filter(c => c.params.number === 1).length, 1);
  assert.equal(calls.filter(c => c.params.number === 2).length, MAX_THREAD_PAGES);
  assert.deepEqual(snapshot.prs.map(p => p.threadsIncomplete), [true, true]);
});

test('rollupState leaves out our own status and reports the worst remaining state', () => {
  const run = (status, conclusion) => ({ __typename: 'CheckRun', name: 'test', status, conclusion });
  const ctx = (context, state) => ({ __typename: 'StatusContext', context, state });
  assert.equal(rollupState([]), null);
  assert.equal(rollupState([ctx(MERGE_POLICY_CONTEXT, 'PENDING')]), null);
  assert.equal(rollupState([run('COMPLETED', 'SUCCESS'), ctx(MERGE_POLICY_CONTEXT, 'FAILURE')]), 'SUCCESS');
  assert.equal(rollupState([run('IN_PROGRESS', null), run('COMPLETED', 'SUCCESS')]), 'PENDING');
  assert.equal(rollupState([run('COMPLETED', 'FAILURE'), ctx('ci', 'PENDING')]), 'FAILURE');
  assert.equal(mergePolicyState([ctx('ci', 'SUCCESS'), ctx(MERGE_POLICY_CONTEXT, 'PENDING')]), 'PENDING');
});

test('rollupState counts only passing conclusions as success; stale and unknown ones are pending', () => {
  const run = (status, conclusion) => ({ __typename: 'CheckRun', name: 'test', status, conclusion });
  const ctx = (context, state) => ({ __typename: 'StatusContext', context, state });
  // Required status checks accept success, neutral and skipped
  assert.equal(rollupState([run('COMPLETED', 'SUCCESS'), run('COMPLETED', 'NEUTRAL'), run('COMPLETED', 'SKIPPED')]), 'SUCCESS');
  assert.equal(rollupState([ctx('ci', 'SUCCESS')]), 'SUCCESS');
  // A stale check run has to be re-run before it passes
  assert.equal(rollupState([run('COMPLETED', 'SUCCESS'), run('COMPLETED', 'STALE')]), 'PENDING');
  // Values GitHub may add later, or a completed run without a conclusion, never pass
  assert.equal(rollupState([run('COMPLETED', 'SOMETHING_NEW')]), 'PENDING');
  assert.equal(rollupState([run('COMPLETED', null)]), 'PENDING');
  assert.equal(rollupState([ctx('ci', 'SOMETHING_NEW')]), 'PENDING');
  assert.equal(rollupState([ctx('ci', 'EXPECTED')]), 'PENDING');
  // Failures still win over pending
  for (const conclusion of ['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE']) {
    assert.equal(rollupState([run('COMPLETED', 'STALE'), run('COMPLETED', conclusion)]), 'FAILURE', conclusion);
  }
  assert.equal(rollupState([run('COMPLETED', 'STALE'), ctx('ci', 'ERROR')]), 'FAILURE');
});
