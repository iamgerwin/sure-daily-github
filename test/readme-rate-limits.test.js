import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_REQUEST_RETRIES,
  DEFAULT_REQUEST_TIMEOUT_MS,
  MAX_RETRY_DELAY_MS,
  SECONDARY_RATE_LIMIT_DELAY_MS
} from '../src/github/octokit.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function rateLimitSection() {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const section = readme.split('### Rate Limit Issues')[1]?.split('\n### ')[0];
  assert.ok(section, 'README.md should have a Rate Limit Issues section');
  return section;
}

// The section is what users read when a run fails on a rate limit; it must
// name the knobs that exist and the defaults the code actually uses
test('the README rate limit section documents the retry settings and their defaults', () => {
  const section = rateLimitSection();
  assert.match(section, new RegExp(`\`GITHUB_REQUEST_RETRIES\`[^\\n]*default \`${DEFAULT_REQUEST_RETRIES}\``));
  assert.match(section, new RegExp(`\`GITHUB_REQUEST_TIMEOUT_MS\`[^\\n]*default \`${DEFAULT_REQUEST_TIMEOUT_MS}\``));
  assert.match(section, new RegExp(`longer than ${MAX_RETRY_DELAY_MS / 1000} seconds`));
  assert.match(section, new RegExp(`at least ${SECONDARY_RATE_LIMIT_DELAY_MS / 1000} seconds`));
});

// The old text promised that "logs will show current limits", which no code
// path did; the section must quote the warning the retry layer really logs
test('the README rate limit section quotes the retry warning logged by the client', () => {
  const source = fs.readFileSync(path.join(root, 'src/github/octokit.js'), 'utf8');
  const logged = source.match(/logger\.warn\('([^']+)'/)?.[1];
  assert.ok(logged, 'octokit.js should log a retry warning');
  assert.ok(rateLimitSection().includes(`\`${logged}\``), `README should quote "${logged}"`);
  assert.doesNotMatch(rateLimitSection(), /logs will show current limits/);
});
