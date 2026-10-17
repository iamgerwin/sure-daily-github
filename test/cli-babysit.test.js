import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cliPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/cli.js');

function cli(...args) {
  return spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8' });
}

test('babysit --help lists the command options', () => {
  const result = cli('babysit', '--help');
  assert.equal(result.status, 0);
  for (const option of ['--once', '--repo <owner/repo>', '--pr <number>', '--dry-run', '--config <path>']) {
    assert.ok(result.stdout.includes(option), `help should mention ${option}`);
  }
  assert.match(result.stdout, /never\s+merges/);
});

test('the top-level help lists the babysit command', () => {
  const result = cli('--help');
  assert.equal(result.status, 0);
  assert.match(result.stdout, /babysit/);
});

test('babysit rejects --pr without exactly one --repo before loading config', () => {
  let result = cli('babysit', '--pr', '3');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--pr requires exactly one --repo/);

  result = cli('babysit', '--pr', '3', '--repo', 'me/a', '--repo', 'me/b');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--pr requires exactly one --repo/);

  result = cli('babysit', '--pr', 'abc', '--repo', 'me/a');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--pr must be a positive pull request number/);
});

test('babysit rejects a malformed --repo', () => {
  const result = cli('babysit', '--repo', 'just-a-name');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--repo must be owner\/repo/);
});
