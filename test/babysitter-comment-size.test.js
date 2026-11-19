import test from 'node:test';
import assert from 'node:assert/strict';

import {
  Babysitter,
  MAX_COMMENT_CHARS,
  REPLY_MARKER,
  fitCommentBody,
  inlineReplyBody,
  summaryCommentBody
} from '../src/core/babysitter.js';

const human = { login: 'alice', type: 'User' };

test('a body within the limit is returned unchanged', () => {
  const body = `Noted. fine\n\n${REPLY_MARKER}`;
  assert.equal(fitCommentBody(body), body);
  const exact = `${'x'.repeat(MAX_COMMENT_CHARS - REPLY_MARKER.length)}${REPLY_MARKER}`;
  assert.equal(fitCommentBody(exact), exact);
});

test('an oversized body is cut to the limit and keeps the marker last', () => {
  const body = `${'x'.repeat(MAX_COMMENT_CHARS * 2)}\n\n${REPLY_MARKER}`;
  const fitted = fitCommentBody(body);
  assert.equal(fitted.length <= MAX_COMMENT_CHARS, true);
  assert.ok(fitted.endsWith(REPLY_MARKER));
  assert.equal(fitted.split(REPLY_MARKER).length, 2, 'marker appears exactly once');
  assert.match(fitted, /truncated to fit GitHub's comment size limit/);
});

test('an oversized body without a marker still gets one', () => {
  const fitted = fitCommentBody('y'.repeat(MAX_COMMENT_CHARS + 10));
  assert.equal(fitted.length <= MAX_COMMENT_CHARS, true);
  assert.ok(fitted.endsWith(REPLY_MARKER));
});

test('the cut never leaves half of a surrogate pair', () => {
  const max = 100;
  for (let pad = 0; pad < 4; pad++) {
    const fitted = fitCommentBody(`${'a'.repeat(pad)}${'😀'.repeat(200)}`, max);
    assert.equal(fitted.length <= max, true);
    assert.doesNotMatch(fitted, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  }
});

test('an inline reply with very long engine reasoning fits the limit', () => {
  const body = inlineReplyBody(
    { user: human },
    { action: 'wontfix', reasoning: 'r'.repeat(MAX_COMMENT_CHARS + 500) },
    null
  );
  assert.equal(body.length <= MAX_COMMENT_CHARS, true);
  assert.ok(body.startsWith('Not changing this: rrr'));
  assert.ok(body.endsWith(REPLY_MARKER));
});

test('a summary covering many long comments fits the limit', () => {
  const entries = Array.from({ length: 40 }, (_, i) => ({
    comment: { kind: 'issue', author: `user${i}`, user: human, url: `https://github.com/o/r/pull/1#issuecomment-${i}` },
    decision: { action: 'note', reasoning: 'n'.repeat(4000) }
  }));
  const body = summaryCommentBody(entries, null);
  assert.equal(body.length <= MAX_COMMENT_CHARS, true);
  assert.ok(body.startsWith('Babysit update for review feedback on this PR:'));
  assert.ok(body.endsWith(REPLY_MARKER));
});

test('deliver posts a stored oversized body cut to the limit', async () => {
  const posted = [];
  const client = {
    createIssueComment: async (owner, repo, number, body) => {
      posted.push(body);
      return { success: true, data: { id: 1 } };
    }
  };
  const ledger = { completeDelivery() {}, failDelivery() { throw new Error('should not fail'); } };
  const counts = { addressed: 0, deferred: 0, wontfix: 0, noted: 0, failed: 0 };
  const delivery = {
    id: 'k#summary', kind: 'summary', owner: 'o', repo: 'r', pr: 1,
    body: `${'z'.repeat(MAX_COMMENT_CHARS + 1)}\n\n${REPLY_MARKER}`,
    keys: ['k'], states: { k: 'noted' }
  };

  const ok = await new Babysitter().deliver({ client, ledger }, delivery, counts);
  assert.equal(ok, true);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].length <= MAX_COMMENT_CHARS, true);
  assert.ok(posted[0].endsWith(REPLY_MARKER));
  assert.equal(counts.noted, 1);
});
