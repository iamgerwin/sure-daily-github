import test from 'node:test';
import assert from 'node:assert/strict';
import { describeBabysitResult } from '../src/core/babysitter.js';

const counts = (overrides = {}) => ({ addressed: 0, deferred: 0, wontfix: 0, noted: 0, failed: 0, ...overrides });

test('describeBabysitResult lists comments left retrying so a failed count has a reason', () => {
  // An engine that exits 0 without a report leaves every fix item retrying
  const lines = describeBabysitResult({
    owner: 'me', repo: 'demo', number: 7, success: false,
    counts: counts({ failed: 2 }), commitSha: null, failures: [],
    retrying: [
      { id: 'review_comment:11', error: 'engine failed: no report written' },
      { id: 'review_comment:12', error: 'engine failed: no report written' }
    ]
  });

  assert.deepEqual(lines, [
    { error: false, text: '🔧 me/demo#7: addressed 0, deferred 0, wontfix 0, noted 0, failed 2' },
    { error: true, text: '   ↻  review_comment:11: engine failed: no report written (retried next run)' },
    { error: true, text: '   ↻  review_comment:12: engine failed: no report written (retried next run)' }
  ]);
});

test('describeBabysitResult prints the reason a delivery or reconcile pass gives', () => {
  const lines = describeBabysitResult({
    owner: 'me', repo: 'demo', number: 7, delivery: true, success: true,
    counts: counts(), reason: 'branch moved after push; reply not delivered'
  });

  assert.deepEqual(lines.map(line => line.text), [
    '🔧 me/demo#7: addressed 0, deferred 0, wontfix 0, noted 0, failed 0',
    '   branch moved after push; reply not delivered'
  ]);
});

test('describeBabysitResult keeps failures after the counts and the pushed commit', () => {
  const lines = describeBabysitResult({
    owner: 'me', repo: 'demo', number: 3, success: false,
    counts: counts({ addressed: 1, failed: 1 }), commitSha: '0123456789abcdef0123',
    failures: [{ id: 'review_comment:5', error: 'tests failed' }], retrying: []
  });

  assert.deepEqual(lines, [
    { error: false, text: '🔧 me/demo#3: addressed 1, deferred 0, wontfix 0, noted 0, failed 1 (pushed 0123456789ab)' },
    { error: true, text: '   ❌ review_comment:5: tests failed' }
  ]);
});

test('describeBabysitResult renders errors, skips and dry-run plans as before', () => {
  assert.deepEqual(describeBabysitResult({ owner: 'me', repo: 'demo', error: 'clone failed' }),
    [{ error: true, text: '❌ me/demo: clone failed' }]);
  assert.deepEqual(describeBabysitResult({ owner: 'me', repo: 'demo', number: 2, skipped: true, reason: 'head branch is on a fork' }),
    [{ error: false, text: '⏭️  me/demo#2: head branch is on a fork' }]);
  assert.deepEqual(describeBabysitResult({
    owner: 'me', repo: 'demo', number: 4,
    planned: [{ action: 'fix', id: 'review_comment:9', author: 'alice', reasoning: 'typo' }],
    undecided: ['review_comment:10']
  }).map(line => line.text), [
    '📝 me/demo#4: 1 planned action(s)',
    '   fix     review_comment:9 by alice: typo',
    '   ???     review_comment:10: no triage decision'
  ]);
});
