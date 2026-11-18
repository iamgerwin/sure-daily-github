import test from 'node:test';
import assert from 'node:assert/strict';
import { fitIssueTitle, MAX_ISSUE_TITLE_LENGTH } from '../src/utils/issue-title.js';

test('fitIssueTitle leaves a title within the limit unchanged', () => {
  assert.equal(fitIssueTitle('Daily Update - 2026-11-18'), 'Daily Update - 2026-11-18');
  const exact = 'x'.repeat(MAX_ISSUE_TITLE_LENGTH);
  assert.equal(fitIssueTitle(exact), exact);
});

test('fitIssueTitle cuts a longer title to the limit and ends it with an ellipsis', () => {
  const fitted = fitIssueTitle('x'.repeat(MAX_ISSUE_TITLE_LENGTH + 1));
  assert.equal([...fitted].length, MAX_ISSUE_TITLE_LENGTH);
  assert.ok(fitted.endsWith('…'));
  assert.equal(fitted, 'x'.repeat(MAX_ISSUE_TITLE_LENGTH - 1) + '…');
});

test('fitIssueTitle counts characters, not UTF-16 units, and never splits an emoji', () => {
  // 256 emoji fit as 256 characters even though they are 512 UTF-16 units
  const fits = '🚀'.repeat(MAX_ISSUE_TITLE_LENGTH);
  assert.equal(fitIssueTitle(fits), fits);

  const fitted = fitIssueTitle('🚀'.repeat(MAX_ISSUE_TITLE_LENGTH + 10));
  assert.equal([...fitted].length, MAX_ISSUE_TITLE_LENGTH);
  assert.equal(fitted, '🚀'.repeat(MAX_ISSUE_TITLE_LENGTH - 1) + '…');
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(fitted), 'no lone high surrogate');
});

test('fitIssueTitle drops whitespace left before the ellipsis', () => {
  const fitted = fitIssueTitle('a'.repeat(MAX_ISSUE_TITLE_LENGTH - 3) + '   tail end');
  assert.equal(fitted, 'a'.repeat(MAX_ISSUE_TITLE_LENGTH - 3) + '…');
});
