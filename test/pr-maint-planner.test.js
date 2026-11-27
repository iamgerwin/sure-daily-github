import test from 'node:test';
import assert from 'node:assert/strict';
import { canAutoClear, clearConditionText, targetLifecycle } from '../src/core/pr-maint.js';
import {
  check, isCleanlyMergeable, clearConditionMet, CLEAR_CONDITIONS, NEVER_AUTO_CLEAR,
  NEEDS_HUMAN, NEEDS_HUMAN_CLEAR_LIMIT, NEEDS_HUMAN_WINDOW_MS
} from '../src/core/policy.js';

const OWNER = 'iamgerwin';
const OLD_SHA = 'a'.repeat(40);
const NEW_SHA = 'b'.repeat(40);
const NOW = Date.UTC(2026, 10, 18, 12);
const DAY_MS = 24 * 60 * 60 * 1000;

function pr(overrides = {}) {
  return {
    number: 7,
    author: OWNER,
    isCrossRepository: false,
    headRefOid: NEW_SHA,
    baseRefName: 'master',
    state: 'OPEN',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    checks: 'SUCCESS',
    labels: ['sdg:waiting', NEEDS_HUMAN],
    reviewThreads: [],
    ...overrides
  };
}

function escalation(overrides = {}) {
  return { reason: 'attempts', headSha: OLD_SHA, active: true, clears: [], ...overrides };
}

test('isCleanlyMergeable needs MERGEABLE plus a merge state GitHub only reports without a conflict', () => {
  for (const state of ['CLEAN', 'HAS_HOOKS', 'UNSTABLE', 'BLOCKED', 'BEHIND', 'DRAFT']) {
    assert.equal(isCleanlyMergeable({ mergeable: 'MERGEABLE', mergeStateStatus: state }), true, state);
  }
  // Not computed yet, conflicting, or a state that does not prove the absence of a conflict
  assert.equal(isCleanlyMergeable({ mergeable: 'MERGEABLE', mergeStateStatus: 'DIRTY' }), false);
  assert.equal(isCleanlyMergeable({ mergeable: 'MERGEABLE', mergeStateStatus: 'UNKNOWN' }), false);
  assert.equal(isCleanlyMergeable({ mergeable: 'UNKNOWN', mergeStateStatus: 'CLEAN' }), false);
  assert.equal(isCleanlyMergeable({ mergeable: 'CONFLICTING', mergeStateStatus: 'CLEAN' }), false);
  assert.equal(isCleanlyMergeable({}), false);
  assert.equal(isCleanlyMergeable(null), false);
  assert.equal(isCleanlyMergeable(undefined), false);
});

test('clearConditionMet evaluates each allowlisted reason against the fresh pull request', () => {
  const moved = pr();
  const same = pr({ headRefOid: OLD_SHA });

  for (const reason of ['attempts', 'uncertain', 'scorecard']) {
    assert.equal(clearConditionMet(escalation({ reason }), moved), true, reason);
    assert.equal(clearConditionMet(escalation({ reason }), same), false, reason);
    // Without a recorded head there is no evidence that it moved
    assert.equal(clearConditionMet(escalation({ reason, headSha: null }), moved), false, reason);
    assert.equal(clearConditionMet(escalation({ reason }), { ...moved, headRefOid: null }), false, reason);
  }

  for (const reason of ['tests-red', 'ci-red-after-change']) {
    assert.equal(clearConditionMet(escalation({ reason }), moved), true, reason);
    assert.equal(clearConditionMet(escalation({ reason }), same), false, reason);
    for (const checks of ['FAILURE', 'PENDING', null]) {
      assert.equal(clearConditionMet(escalation({ reason }), { ...moved, checks }), false, `${reason} ${checks}`);
    }
  }

  for (const reason of ['non-text', 'lockfile']) {
    // The head does not have to move: a base-branch fix can clear the conflict
    assert.equal(clearConditionMet(escalation({ reason }), same), true, reason);
    assert.equal(clearConditionMet(escalation({ reason }), { ...moved, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }), false, reason);
    assert.equal(clearConditionMet(escalation({ reason }), { ...moved, mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }), false, reason);
  }
});

test('clearConditionMet is false for human-only, unknown and inherited reasons', () => {
  for (const reason of [...NEVER_AUTO_CLEAR, 'something-new', 'toString', 'constructor', '__proto__', undefined]) {
    assert.equal(clearConditionMet(escalation({ reason }), pr()), false, String(reason));
  }
  assert.equal(clearConditionMet(null, pr()), false);
  assert.equal(clearConditionMet(undefined, pr()), false);
});

test('clearConditionText names the allowlisted condition, else a human', () => {
  for (const [reason, { text }] of Object.entries(CLEAR_CONDITIONS)) {
    assert.equal(clearConditionText(reason), text);
  }
  for (const reason of [...NEVER_AUTO_CLEAR, 'something-new', 'toString', '__proto__', undefined]) {
    assert.equal(clearConditionText(reason), 'a human removes needs-human', String(reason));
  }
});

test('head-based clearing conditions promise only a new head, which is all they check', () => {
  // A base branch push leaves the head where it was: the escalation must stay,
  // so the text a human reads must not promise that a base move clears it
  const baseMoved = pr({ headRefOid: OLD_SHA, baseRefName: 'release' });
  for (const reason of ['attempts', 'uncertain', 'scorecard']) {
    assert.equal(clearConditionMet(escalation({ reason }), baseMoved), false, reason);
    assert.equal(clearConditionText(reason), 'a new commit is pushed', reason);
    assert.doesNotMatch(clearConditionText(reason), /base/, reason);
  }
});

test('canAutoClear refuses inactive escalations and reasons only a human may clear', () => {
  assert.equal(canAutoClear(escalation(), pr(), NOW), true);
  assert.equal(canAutoClear(escalation({ active: false }), pr(), NOW), false);
  assert.equal(canAutoClear(null, pr(), NOW), false);
  assert.equal(canAutoClear(undefined, pr(), NOW), false);
  for (const reason of NEVER_AUTO_CLEAR) {
    assert.equal(canAutoClear(escalation({ reason }), pr(), NOW), false, reason);
  }
  assert.equal(canAutoClear(escalation({ reason: 'something-new' }), pr(), NOW), false);
  // The condition must hold on the current pull request
  assert.equal(canAutoClear(escalation(), pr({ headRefOid: OLD_SHA }), NOW), false);
});

test('canAutoClear stops at the clear limit within the 7-day window and forgets older clears', () => {
  const recent = Array.from({ length: NEEDS_HUMAN_CLEAR_LIMIT }, (_, i) => NOW - (i + 1) * DAY_MS);
  assert.equal(canAutoClear(escalation({ clears: recent.slice(0, -1) }), pr(), NOW), true);
  assert.equal(canAutoClear(escalation({ clears: recent }), pr(), NOW), false);

  // A clear exactly one window old no longer counts; one millisecond younger still does
  const atEdge = [...recent.slice(0, -1), NOW - NEEDS_HUMAN_WINDOW_MS];
  assert.equal(canAutoClear(escalation({ clears: atEdge }), pr(), NOW), true);
  const insideEdge = [...recent.slice(0, -1), NOW - NEEDS_HUMAN_WINDOW_MS + 1];
  assert.equal(canAutoClear(escalation({ clears: insideEdge }), pr(), NOW), false);

  // Missing history counts as no clears
  assert.equal(canAutoClear(escalation({ clears: undefined }), pr(), NOW), true);
});

// The planner proposes a needs-human removal only when canAutoClear holds, and
// the needs-human policy rule then vets the write. If they disagreed, pr-maint
// would either plan a write the policy always denies (a wasted write slot and a
// denial on every tick) or never plan a clear the policy would allow.
test('canAutoClear agrees with the needs-human policy rule on every escalation and PR state', () => {
  const reasons = [...Object.keys(CLEAR_CONDITIONS), ...NEVER_AUTO_CLEAR, 'something-new', 'toString'];
  const prStates = [
    pr(),
    pr({ headRefOid: OLD_SHA }),
    pr({ checks: 'FAILURE' }),
    pr({ checks: 'PENDING' }),
    pr({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }),
    pr({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }),
    pr({ headRefOid: OLD_SHA, mergeable: 'MERGEABLE', mergeStateStatus: 'BEHIND' })
  ];
  const clearHistories = [
    [],
    [NOW - DAY_MS],
    [NOW - DAY_MS, NOW - 2 * DAY_MS],
    [NOW - DAY_MS, NOW - NEEDS_HUMAN_WINDOW_MS],
    [NOW - 8 * DAY_MS, NOW - 9 * DAY_MS, NOW - 10 * DAY_MS]
  ];

  let allowed = 0;
  let cases = 0;
  for (const reason of reasons) {
    for (const active of [true, false]) {
      for (const fresh of prStates) {
        for (const clears of clearHistories) {
          const esc = escalation({ reason, active, clears });
          // Pinned to the head it was planned on, as the planner does
          const action = { type: 'label.remove', scope: 'pr', pr: 7, headSha: fresh.headRefOid, payload: { label: NEEDS_HUMAN } };
          const verdict = check(action, fresh, {
            mode: 'act',
            owner: OWNER,
            authors: [OWNER],
            caps: { writesPerPrPerTick: 20, writesPerHour: 200 },
            writes: { pr: 0, hour: 0 },
            escalation: esc,
            now: NOW
          });
          const policyAllows = !(verdict.allowed === false && verdict.rule === 'needs-human');
          const label = JSON.stringify({ reason, active, head: fresh.headRefOid.slice(0, 1), checks: fresh.checks, mergeable: fresh.mergeable, clears: clears.length, verdict });
          assert.equal(canAutoClear(esc, fresh, NOW), policyAllows, label);
          // When both agree it may be cleared, no other rule stands in the way
          if (policyAllows) assert.equal(verdict.allowed, true, label);
          if (verdict.allowed) allowed++;
          cases++;
        }
      }
    }
  }
  // Both outcomes are exercised, so the agreement is not vacuous
  assert.ok(allowed > 0 && allowed < cases, `${allowed} of ${cases} allowed`);
});

test('targetLifecycle moves a conflicted pull request to sdg:conflict', () => {
  for (const conflict of [{ mergeable: 'CONFLICTING' }, { mergeStateStatus: 'DIRTY' }]) {
    const target = targetLifecycle(pr({ labels: ['sdg:waiting'], ...conflict }));
    assert.equal(target.label, 'sdg:conflict', JSON.stringify(conflict));
    assert.match(target.why, /`master`/);
  }
});

test('targetLifecycle keeps the current label while mergeability is not computed', () => {
  assert.equal(targetLifecycle(pr({ mergeable: 'UNKNOWN', labels: ['sdg:conflict'] })).label, 'sdg:conflict');
  assert.equal(targetLifecycle(pr({ mergeable: 'UNKNOWN', labels: ['sdg:ready'] })).label, 'sdg:ready');
  // Nothing to keep: no label is added on a guess
  const none = targetLifecycle(pr({ mergeable: 'UNKNOWN', labels: [] }));
  assert.equal(none.label, null);
  assert.equal(none.next, 're-check on the next tick');
});

test('targetLifecycle moves a cleared conflict to sdg:waiting and names what it waits for', () => {
  const cleared = (overrides) => targetLifecycle(pr({ labels: ['sdg:conflict'], ...overrides }));
  assert.equal(cleared({}).label, 'sdg:waiting');
  assert.equal(cleared({}).why, 'the conflict was cleared by a push');
  assert.equal(cleared({ checks: 'FAILURE' }).next, 'checks are failing');
  assert.equal(cleared({ checks: 'PENDING' }).next, 'waiting for checks');
  const thread = (isResolved) => ({ id: 'T', isResolved, author: 'reviewer' });
  assert.equal(cleared({ reviewThreads: [thread(false)] }).next, '1 unresolved review thread');
  assert.equal(cleared({ reviewThreads: [thread(false), thread(false), thread(true)] }).next, '2 unresolved review threads');
  assert.match(cleared({ reviewThreads: [thread(true)] }).next, /merge policy/);
});

test('targetLifecycle keeps the fixing and ready labels and defaults to sdg:waiting', () => {
  const fixing = targetLifecycle(pr({ labels: ['sdg:fixing'] }));
  assert.deepEqual([fixing.label, fixing.next], ['sdg:fixing', 'handled by a later flow']);
  const ready = targetLifecycle(pr({ labels: ['sdg:ready'] }));
  assert.deepEqual([ready.label, ready.next], ['sdg:ready', 'handled by a later flow']);
  const unlabeled = targetLifecycle(pr({ labels: [] }));
  assert.equal(unlabeled.label, 'sdg:waiting');
  assert.equal(unlabeled.why, 'no open conflict');
});
