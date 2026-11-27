import test from 'node:test';
import assert from 'node:assert/strict';

import { inlineReplyBody, summaryCommentBody, REPLY_MARKER } from '../src/core/babysitter.js';

const bot = { type: 'Bot', login: 'coderabbitai[bot]' };
const human = { type: 'User', login: 'alice' };
const fix = { commitSha: '0123456789abcdef0123', changedFiles: ['src/a.js', 'src/b.js'], report: null };

const inline = (overrides = {}) => ({ id: 'review_comment:1', kind: 'review_comment', user: human, author: 'alice', ...overrides });

test('a fix reply names the short commit, the plan and the changed files, then asks for a re-review', () => {
  const body = inlineReplyBody(inline(), { action: 'fix', reasoning: 'off by one', plan: 'use <=' }, fix);
  assert.equal(body, [
    'Fixed in 0123456789ab: use <=',
    '',
    'Changed: `src/a.js`, `src/b.js`',
    '',
    'Please re-review.',
    '',
    REPLY_MARKER
  ].join('\n'));
});

test('a fix reply mentions a bot reviewer without its [bot] suffix', () => {
  const body = inlineReplyBody(inline({ user: bot }), { action: 'fix', reasoning: 'r', plan: 'p' }, fix);
  assert.match(body, /\n\n@coderabbitai please re-review\.\n\n/);
  assert.doesNotMatch(body, /\[bot\]/);
});

test('reReview: false leaves out the re-review request', () => {
  const body = inlineReplyBody(inline({ user: bot }), { action: 'fix', reasoning: 'r', plan: 'p' }, fix, { reReview: false });
  assert.doesNotMatch(body, /re-review/);
  assert.ok(body.endsWith(`\n\n${REPLY_MARKER}`));
});

test('a fix reply prefers the reported summary and locations for that comment', () => {
  const reported = {
    ...fix,
    report: {
      fixes: [
        { id: 'review_comment:2', summary: 'other', locations: [{ path: 'x.js' }] },
        { id: 'review_comment:1', summary: 'guarded the empty list', locations: [{ path: 'src/a.js', line: 12 }, { path: 'README.md' }] }
      ]
    }
  };
  const body = inlineReplyBody(inline(), { action: 'fix', reasoning: 'r', plan: 'p' }, reported);
  assert.match(body, /^Fixed in 0123456789ab: guarded the empty list\n\nChanged: `src\/a\.js:12`, `README\.md`\n/);
});

test('a fix reply falls back to the reasoning without a plan and omits an empty change list', () => {
  const body = inlineReplyBody(inline(), { action: 'fix', reasoning: 'renamed it' }, { ...fix, changedFiles: [] });
  assert.match(body, /^Fixed in 0123456789ab: renamed it\n\nPlease re-review\./);
  assert.doesNotMatch(body, /Changed:/);
});

test('a fix reply lists at most ten changed files', () => {
  const changedFiles = Array.from({ length: 12 }, (_, i) => `f${i}.js`);
  const body = inlineReplyBody(inline(), { action: 'fix', reasoning: 'r', plan: 'p' }, { ...fix, changedFiles });
  assert.match(body, /`f9\.js`\n/);
  assert.doesNotMatch(body, /f10\.js|f11\.js/);
});

test('defer, wontfix and note replies carry the reasoning and optional plan', () => {
  assert.equal(
    inlineReplyBody(inline({ user: bot }), { action: 'defer', reasoning: 'out of scope', plan: 'issue #9' }, null),
    `@coderabbitai Deferring this: out of scope\n\nFollow-up: issue #9\n\n${REPLY_MARKER}`
  );
  assert.equal(
    inlineReplyBody(inline(), { action: 'defer', reasoning: 'out of scope' }, null),
    `Deferring this: out of scope\n\n${REPLY_MARKER}`
  );
  assert.equal(
    inlineReplyBody(inline(), { action: 'wontfix', reasoning: 'intended', plan: 'ignored' }, null),
    `Not changing this: intended\n\n${REPLY_MARKER}`
  );
  assert.equal(
    inlineReplyBody(inline(), { action: 'note', reasoning: 'thanks', plan: 'docs/X.md' }, null),
    `Noted. thanks\n\nSee: docs/X.md\n\n${REPLY_MARKER}`
  );
});

test('non-fix replies never ask for a re-review, even from a bot', () => {
  for (const action of ['defer', 'wontfix', 'note']) {
    assert.doesNotMatch(inlineReplyBody(inline({ user: bot }), { action, reasoning: 'r' }, fix), /re-review/, action);
  }
});

const entry = (overrides = {}) => ({
  comment: { id: 'issue_comment:5', kind: 'issue_comment', user: human, author: 'alice', url: 'https://example.test/c/5' },
  decision: { action: 'note', reasoning: 'noted' },
  ...overrides
});

test('the summary lists each entry with a link, its author and its state', () => {
  const body = summaryCommentBody([
    entry({ decision: { action: 'wontfix', reasoning: 'by design' } }),
    entry({ comment: { id: 'review:6', kind: 'review', user: human, author: 'bob' }, decision: { action: 'defer', reasoning: 'later' } })
  ], null);
  assert.equal(body, [
    'Babysit update for review feedback on this PR:',
    '',
    "- [comment](https://example.test/c/5) by `alice`: **won't fix**: by design",
    '- review by `bob`: **deferred**: later',
    '',
    REPLY_MARKER
  ].join('\n'));
});

test('the summary keeps each entry on one line', () => {
  const body = summaryCommentBody([
    entry({ decision: { action: 'note', reasoning: 'first\n\nsecond\nthird' } }),
    entry({ decision: { action: 'fix', reasoning: 'r', plan: 'p' } })
  ], fix);
  assert.match(body, /\*\*noted\*\*: first second third\n/);
  assert.match(body, /\*\*fixed\*\*: Fixed in 0123456789ab: p Changed: `src\/a\.js`, `src\/b\.js`\n/);
});

test('the summary reports an entry that gave up', () => {
  const body = summaryCommentBody([entry({ decision: undefined, failed: true, error: 'engine timed out' })], null);
  assert.match(body, /by `alice`: \*\*failed\*\*: Automated handling failed after \d+ attempts \(engine timed out\)\. Leaving this for manual follow-up\./);
});

test('the summary asks bots to re-review only when a fix was pushed', () => {
  const entries = [
    entry({ comment: { id: 'review:7', kind: 'review', user: bot, author: 'coderabbitai[bot]' }, decision: { action: 'defer', reasoning: 'later' } })
  ];
  assert.doesNotMatch(summaryCommentBody(entries, null), /re-review/);
  assert.match(summaryCommentBody(entries, fix), /\n\n@coderabbitai please re-review the latest changes\.\n\n/);
});

test('the summary asks each bot once and skips bots already asked for this head', () => {
  const other = { type: 'Bot', login: 'copilot[bot]' };
  const entries = [
    entry({ comment: { id: 'review:7', kind: 'review', user: bot, author: 'coderabbitai[bot]' } }),
    entry({ comment: { id: 'issue_comment:8', kind: 'issue_comment', user: bot, author: 'coderabbitai[bot]' } }),
    entry({ comment: { id: 'review:9', kind: 'review', user: other, author: 'copilot[bot]' } })
  ];
  const both = summaryCommentBody(entries, fix);
  assert.match(both, /\n@coderabbitai @copilot please re-review the latest changes\./);

  const rest = summaryCommentBody(entries, fix, new Set(['@coderabbitai']));
  assert.match(rest, /\n@copilot please re-review the latest changes\./);
  assert.doesNotMatch(rest, /@coderabbitai please/);

  assert.doesNotMatch(summaryCommentBody(entries, fix, new Set(['@coderabbitai', '@copilot'])), /re-review/);
});
