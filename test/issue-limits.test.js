import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fitIssueTitle,
  fitIssueBody,
  MAX_ISSUE_TITLE_CHARS,
  MAX_ISSUE_BODY_CHARS
} from '../src/github/issue-limits.js';

test('fitIssueTitle leaves a title at or under the limit unchanged', () => {
  assert.equal(fitIssueTitle('Daily Update - 2026-11-25'), 'Daily Update - 2026-11-25');
  const exact = 'x'.repeat(MAX_ISSUE_TITLE_CHARS);
  assert.equal(fitIssueTitle(exact), exact);
});

test('fitIssueTitle cuts an oversized title to the limit with an ellipsis', () => {
  const title = fitIssueTitle('t'.repeat(MAX_ISSUE_TITLE_CHARS + 50));
  assert.equal(title.length, MAX_ISSUE_TITLE_CHARS);
  assert.ok(title.endsWith('...'));
  assert.ok(title.startsWith('ttt'));
});

test('fitIssueTitle does not leave half of a surrogate pair at the cut', () => {
  // The emoji straddles the cut point (253 code units kept before the ellipsis)
  const title = fitIssueTitle(`${'a'.repeat(252)}😀${'b'.repeat(20)}`);
  assert.ok(title.length <= MAX_ISSUE_TITLE_CHARS);
  assert.equal(title, `${'a'.repeat(252)}...`);
  assert.doesNotMatch(title, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
});

test('fitIssueBody cuts an oversized body with a truncation note', () => {
  const body = fitIssueBody('line\n'.repeat(MAX_ISSUE_BODY_CHARS));
  assert.ok(body.length <= MAX_ISSUE_BODY_CHARS);
  assert.match(body, /truncated to fit GitHub's issue size limit\)$/);
  assert.ok(body.startsWith('line\nline\n'));
});

test('fitIssueBody leaves a body at the limit unchanged', () => {
  const body = 'b'.repeat(MAX_ISSUE_BODY_CHARS);
  assert.equal(fitIssueBody(body), body);
});

test('non-string values pass through untouched', () => {
  assert.equal(fitIssueTitle(undefined), undefined);
  assert.equal(fitIssueBody(null), null);
});
