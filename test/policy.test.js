import test from 'node:test';
import assert from 'node:assert/strict';
import {
  check, RULES, ACTION_TYPES, MARKERS, MERGE_POLICY_CONTEXT, NEEDS_HUMAN, PAUSED, MAX_TEXT_BYTES,
  NEEDS_HUMAN_WINDOW_MS, downgradeMode, mentions
} from '../src/core/policy.js';

const OWNER = 'iamgerwin';
const SHA = 'a'.repeat(40);
const NOW = Date.UTC(2026, 9, 17, 12);

function freshPr(overrides = {}) {
  return {
    number: 7,
    author: OWNER,
    isCrossRepository: false,
    headRefOid: SHA,
    state: 'OPEN',
    labels: ['sdg:waiting'],
    reviewThreads: [
      { id: 'T1', isResolved: false, author: 'coderabbitai[bot]' },
      { id: 'T2', isResolved: false, author: OWNER },
      { id: 'T3', isResolved: true, author: 'coderabbitai[bot]' }
    ],
    ...overrides
  };
}

function baseCtx(overrides = {}) {
  return {
    mode: 'act',
    owner: OWNER,
    authors: [OWNER],
    caps: { writesPerPrPerTick: 20, writesPerHour: 200 },
    writes: { pr: 0, hour: 0 },
    escalation: null,
    now: NOW,
    ...overrides
  };
}

// One allowed action per type
function baseAction(type) {
  const action = { type, scope: 'pr', pr: 7, headSha: SHA };
  switch (type) {
    case 'label.add': return { ...action, payload: { label: 'conflict-resolved' } };
    case 'label.remove': return { ...action, payload: { label: 'sdg:waiting' } };
    case 'comment.upsert': return { ...action, payload: { marker: 'status', body: `${MARKERS.status}\nState: waiting. @${OWNER} FYI.` } };
    case 'thread.resolve': return { ...action, payload: { threadId: 'T1', outcome: 'fixed' } };
    case 'status.post': return { ...action, payload: { context: MERGE_POLICY_CONTEXT, state: 'pending', description: 'Merge policy not evaluated yet' } };
    default: throw new Error(type);
  }
}

const textOf = (action) => (action.type === 'comment.upsert' ? 'body' : 'description');
const TEXT_TYPES = ['comment.upsert', 'status.post'];
const LABEL_TYPES = ['label.add', 'label.remove'];

// Every deny rule: the action types it covers and a scenario that trips it.
// For the other types the same scenario must not be denied by that rule.
const CASES = [
  { rule: 'type', kind: 'impossible', types: ACTION_TYPES, mutate: (a) => { a.scope = 'repository'; } },
  { rule: 'scope', kind: 'impossible', types: ACTION_TYPES, name: 'fork', mutate: (a, f) => { f.isCrossRepository = true; } },
  { rule: 'scope', kind: 'impossible', types: ACTION_TYPES, name: 'author', mutate: (a, f) => { f.author = 'stranger'; } },
  {
    rule: 'scope', kind: 'impossible', types: ACTION_TYPES, name: 'dashboard',
    mutate: (a) => { a.scope = 'dashboard'; a.pr = null; }
  },
  {
    rule: 'scope', kind: 'impossible', types: ['status.post'], name: 'status context',
    mutate: (a) => { if (a.type === 'status.post') a.payload.context = 'ci/test'; }
  },
  {
    rule: 'scope', kind: 'impossible', types: ['thread.resolve'], name: 'foreign thread',
    mutate: (a) => { if (a.type === 'thread.resolve') a.payload.threadId = 'T-other-pr'; }
  },
  {
    rule: 'labels', kind: 'impossible', types: LABEL_TYPES, name: 'kill switch',
    mutate: (a) => { if (a.payload.label) a.payload.label = PAUSED; }
  },
  {
    rule: 'labels', kind: 'impossible', types: LABEL_TYPES, name: 'unmanaged',
    mutate: (a) => { if (a.payload.label) a.payload.label = 'bug'; }
  },
  {
    rule: 'text-safety', kind: 'impossible', types: TEXT_TYPES, name: 'attribution',
    mutate: (a) => { if (TEXT_TYPES.includes(a.type)) a.payload[textOf(a)] += ' Co-Authored-By: x'; }
  },
  {
    rule: 'text-safety', kind: 'impossible', types: TEXT_TYPES, name: 'model name',
    mutate: (a) => { if (TEXT_TYPES.includes(a.type)) a.payload[textOf(a)] += ' by Claude'; }
  },
  {
    rule: 'text-safety', kind: 'impossible', types: TEXT_TYPES, name: 'secret',
    mutate: (a) => { if (TEXT_TYPES.includes(a.type)) a.payload[textOf(a)] += ' ghp_abcdef123456'; }
  },
  {
    rule: 'text-safety', kind: 'impossible', types: TEXT_TYPES, name: 'api key',
    mutate: (a) => { if (TEXT_TYPES.includes(a.type)) a.payload[textOf(a)] += ' sk-ant-xyz'; }
  },
  {
    rule: 'text-format', kind: 'deny', types: ['comment.upsert'], name: 'missing marker',
    mutate: (a) => { if (a.type === 'comment.upsert') a.payload.body = 'no marker'; }
  },
  {
    rule: 'text-format', kind: 'deny', types: TEXT_TYPES, name: 'mention',
    mutate: (a) => { if (TEXT_TYPES.includes(a.type)) a.payload[textOf(a)] += ' @coderabbitai'; }
  },
  {
    rule: 'text-format', kind: 'deny', types: TEXT_TYPES, name: 'slash command',
    mutate: (a) => { if (TEXT_TYPES.includes(a.type)) a.payload[textOf(a)] = `/sdg merge ${a.payload[textOf(a)]}`; }
  },
  {
    rule: 'text-format', kind: 'deny', types: TEXT_TYPES, name: 'length',
    mutate: (a) => { if (TEXT_TYPES.includes(a.type)) a.payload[textOf(a)] += 'x'.repeat(MAX_TEXT_BYTES); }
  },
  {
    rule: 'status', kind: 'deny', types: ['status.post'], name: 'verdict',
    mutate: (a) => { if (a.type === 'status.post') a.payload.state = 'success'; }
  },
  {
    rule: 'lifecycle', kind: 'deny', types: ['label.add'],
    mutate: (a) => { if (a.type === 'label.add') a.payload.label = 'sdg:conflict'; }
  },
  {
    rule: 'needs-human', kind: 'deny', types: ['label.remove'], name: 'human-set',
    mutate: (a) => { if (a.type === 'label.remove') a.payload.label = NEEDS_HUMAN; }
  },
  {
    rule: 'escalated', kind: 'deny', types: ['label.add', 'label.remove', 'thread.resolve', 'status.post'],
    mutate: (a, f) => { f.labels = [...f.labels, NEEDS_HUMAN]; }
  },
  {
    rule: 'thread', kind: 'deny', types: ['thread.resolve'], name: 'already resolved',
    mutate: (a) => { if (a.type === 'thread.resolve') a.payload.threadId = 'T3'; }
  },
  {
    rule: 'thread', kind: 'deny', types: ['thread.resolve'], name: 'owner thread declined',
    mutate: (a) => { if (a.type === 'thread.resolve') Object.assign(a.payload, { threadId: 'T2', outcome: 'declined' }); }
  },
  { rule: 'mode', kind: 'deny', types: ACTION_TYPES, mutate: (a, f, c) => { c.mode = 'shadow'; } },
  { rule: 'paused', kind: 'deny', types: ACTION_TYPES, mutate: (a, f) => { f.labels = [...f.labels, PAUSED]; } },
  { rule: 'rate', kind: 'trip', types: ACTION_TYPES, name: 'per PR', mutate: (a, f, c) => { c.writes.pr = 20; } },
  { rule: 'rate', kind: 'trip', types: ACTION_TYPES, name: 'per hour', mutate: (a, f, c) => { c.writes.hour = 200; } },
  { rule: 'head-pin', kind: 'deny', types: ACTION_TYPES, name: 'moved', mutate: (a, f) => { f.headRefOid = 'b'.repeat(40); } },
  { rule: 'head-pin', kind: 'deny', types: ACTION_TYPES, name: 'closed', mutate: (a, f) => { f.state = 'CLOSED'; } }
];

for (const type of ACTION_TYPES) {
  test(`policy allows the baseline ${type}`, () => {
    assert.deepEqual(check(baseAction(type), freshPr(), baseCtx()), { allowed: true });
  });
}

for (const testCase of CASES) {
  for (const type of ACTION_TYPES) {
    const label = `${testCase.rule}${testCase.name ? ` (${testCase.name})` : ''}`;
    test(`policy: ${type} x ${label}`, () => {
      const action = structuredClone(baseAction(type));
      const fresh = freshPr();
      const ctx = baseCtx();
      testCase.mutate(action, fresh, ctx);
      const verdict = check(action, fresh, ctx);

      if (testCase.types.includes(type)) {
        assert.equal(verdict.allowed, false);
        assert.equal(verdict.rule, testCase.rule, verdict.reason);
        assert.equal(verdict.kind, testCase.kind);
        assert.equal(verdict.trip, testCase.kind !== 'deny');
        assert.equal(verdict.escalate, testCase.kind === 'impossible');
      } else {
        assert.ok(verdict.allowed || verdict.rule !== testCase.rule, `${type} must not be denied by ${testCase.rule}`);
      }
    });
  }
}

test('every policy rule has a deny case in the table', () => {
  const covered = new Set(CASES.map(c => c.rule));
  assert.deepEqual(RULES.map(r => r.rule).filter(rule => !covered.has(rule)), []);
});

test('policy rejects an unknown action type as impossible', () => {
  const verdict = check({ ...baseAction('label.add'), type: 'merge' }, freshPr(), baseCtx());
  assert.equal(verdict.rule, 'type');
  assert.equal(verdict.escalate, true);
});

test('shadow mode allows only the dashboard body upsert', () => {
  const dashboard = {
    type: 'comment.upsert', scope: 'dashboard', pr: null, headSha: null,
    payload: { marker: 'dashboard', body: `${MARKERS.dashboard}\n## sdg: PR automation` }
  };
  assert.deepEqual(check(dashboard, null, baseCtx({ mode: 'shadow' })), { allowed: true });
  for (const type of ACTION_TYPES) {
    assert.equal(check(baseAction(type), freshPr(), baseCtx({ mode: 'shadow' })).rule, 'mode');
  }
});

test('the dashboard body still goes through the text policy', () => {
  const dashboard = {
    type: 'comment.upsert', scope: 'dashboard', pr: null, headSha: null,
    payload: { marker: 'dashboard', body: `${MARKERS.dashboard}\nhey @someone` }
  };
  assert.equal(check(dashboard, null, baseCtx({ mode: 'shadow' })).rule, 'text-format');
});

test('a sticky comment with the dashboard marker is out of scope on a PR', () => {
  const action = baseAction('comment.upsert');
  action.payload = { marker: 'dashboard', body: MARKERS.dashboard };
  assert.equal(check(action, freshPr(), baseCtx()).rule, 'scope');
});

test('needs-human may be auto-cleared only for an active, clearable escalation under the cap', () => {
  const action = { ...baseAction('label.remove'), payload: { label: NEEDS_HUMAN } };
  const fresh = freshPr({ labels: ['sdg:conflict', NEEDS_HUMAN], mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' });
  const escalation = { active: true, reason: 'non-text', clears: [] };

  assert.deepEqual(check(action, fresh, baseCtx({ escalation })), { allowed: true });
  assert.equal(check(action, fresh, baseCtx({ escalation: { ...escalation, active: false } })).rule, 'needs-human');
  assert.equal(check(action, fresh, baseCtx({ escalation: { ...escalation, reason: 'policy-denial' } })).rule, 'needs-human');
  assert.equal(check(action, fresh, baseCtx({ escalation: { ...escalation, reason: 'flapping' } })).rule, 'needs-human');

  const twice = { ...escalation, clears: [NOW - 1000, NOW - 2000] };
  assert.match(check(action, fresh, baseCtx({ escalation: twice })).reason, /2 times in 7 days/);
  const longAgo = { ...escalation, clears: [NOW - NEEDS_HUMAN_WINDOW_MS - 1, NOW - NEEDS_HUMAN_WINDOW_MS - 2] };
  assert.deepEqual(check(action, fresh, baseCtx({ escalation: longAgo })), { allowed: true });
});

test('needs-human removal is denied when the clearing condition does not hold on the fresh state', () => {
  const action = { ...baseAction('label.remove'), payload: { label: NEEDS_HUMAN } };
  const fresh = freshPr({ labels: ['sdg:waiting', NEEDS_HUMAN], mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', checks: 'SUCCESS' });
  const verdict = (escalation, f = fresh) => check(action, f, baseCtx({ escalation: { active: true, clears: [], ...escalation } }));

  // Same head: a head-based condition has not been met
  const sameHead = verdict({ reason: 'attempts', headSha: SHA });
  assert.equal(sameHead.rule, 'needs-human');
  assert.match(sameHead.reason, /clearing condition does not hold/);
  assert.deepEqual(verdict({ reason: 'attempts', headSha: 'c'.repeat(40) }), { allowed: true });
  // No recorded head is no evidence that it moved
  assert.equal(verdict({ reason: 'uncertain', headSha: null }).rule, 'needs-human');
  // tests-red needs green checks as well as a new head
  assert.equal(verdict({ reason: 'tests-red', headSha: 'c'.repeat(40) }, { ...fresh, checks: 'FAILURE' }).rule, 'needs-human');
  assert.deepEqual(verdict({ reason: 'tests-red', headSha: 'c'.repeat(40) }), { allowed: true });
  // Conflict-based conditions fail closed on UNKNOWN or conflicting mergeability
  for (const merge of [
    { mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' },
    { mergeable: 'MERGEABLE', mergeStateStatus: 'UNKNOWN' },
    { mergeable: 'MERGEABLE', mergeStateStatus: 'DIRTY' },
    { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' },
    { mergeable: undefined, mergeStateStatus: undefined }
  ]) {
    assert.equal(verdict({ reason: 'lockfile' }, { ...fresh, ...merge }).rule, 'needs-human', JSON.stringify(merge));
  }
});

test('needs-human removal is denied for an unrecognized escalation reason', () => {
  const action = { ...baseAction('label.remove'), payload: { label: NEEDS_HUMAN } };
  const fresh = freshPr({ labels: [NEEDS_HUMAN], mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', headRefOid: SHA });
  for (const reason of ['made-up', 'toString', '__proto__', undefined]) {
    const verdict = check(action, fresh, baseCtx({ escalation: { active: true, reason, headSha: 'c'.repeat(40), clears: [] } }));
    assert.equal(verdict.rule, 'needs-human', String(reason));
  }
});

test('the rate rule reserves the full cost of a multi-write action', () => {
  const dashboard = {
    type: 'comment.upsert', scope: 'dashboard', pr: null, headSha: null,
    payload: { marker: 'dashboard', body: `${MARKERS.dashboard}\nx` }
  };
  assert.deepEqual(check(dashboard, null, baseCtx({ writes: { pr: 0, hour: 199 } })), { allowed: true });
  assert.equal(check(dashboard, null, baseCtx({ writes: { pr: 0, hour: 199 }, cost: 2 })).rule, 'rate');
});

test('an escalated PR still takes its sticky comment and the needs-human label', () => {
  const fresh = freshPr({ labels: ['sdg:conflict', NEEDS_HUMAN] });
  assert.deepEqual(check(baseAction('comment.upsert'), fresh, baseCtx()), { allowed: true });
  const add = { ...baseAction('label.add'), payload: { label: NEEDS_HUMAN } };
  assert.deepEqual(check(add, fresh, baseCtx()), { allowed: true });
});

test('re-adding the current lifecycle label is not an invariant violation', () => {
  const action = { ...baseAction('label.add'), payload: { label: 'sdg:waiting' } };
  assert.deepEqual(check(action, freshPr(), baseCtx()), { allowed: true });
});

test('owner threads may be resolved once fixed; bot threads may be resolved when declined', () => {
  const owner = { ...baseAction('thread.resolve'), payload: { threadId: 'T2', outcome: 'fixed' } };
  assert.deepEqual(check(owner, freshPr(), baseCtx()), { allowed: true });
  const bot = { ...baseAction('thread.resolve'), payload: { threadId: 'T1', outcome: 'declined' } };
  assert.deepEqual(check(bot, freshPr(), baseCtx()), { allowed: true });
});

test('mentions ignores email addresses and finds bot logins', () => {
  assert.deepEqual(mentions('mail me@example.com or @coderabbitai[bot] and @iamgerwin'), ['coderabbitai[bot]', 'iamgerwin']);
});

test('the status description is capped at 140 characters', () => {
  const action = baseAction('status.post');
  action.payload.description = 'x'.repeat(141);
  assert.match(check(action, freshPr(), baseCtx()).reason, /140 characters/);
});

test('downgradeMode steps autonomous to act to shadow', () => {
  assert.equal(downgradeMode('autonomous'), 'act');
  assert.equal(downgradeMode('act'), 'shadow');
  assert.equal(downgradeMode('shadow'), 'shadow');
});
