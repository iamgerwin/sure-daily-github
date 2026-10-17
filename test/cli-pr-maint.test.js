import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cliPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/cli.js');

function cli(...args) {
  return spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8' });
}

test('pr-maint --help lists the command options', () => {
  const result = cli('pr-maint', '--help');
  assert.equal(result.status, 0);
  for (const option of ['--mode <mode>', '--once', '--repo <owner/repo>', '--pr <number>', '--dry-run', '--config <path>']) {
    assert.ok(result.stdout.includes(option), `help should mention ${option}`);
  }
  assert.match(result.stdout, /shadow, act, autonomous/);
  assert.match(result.stdout, /never\s+merges/);
});

test('the top-level help lists the pr-maint command', () => {
  const result = cli('--help');
  assert.equal(result.status, 0);
  assert.match(result.stdout, /pr-maint/);
});

test('pr-maint rejects an unknown --mode before loading config', () => {
  const result = cli('pr-maint', '--mode', 'yolo');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--mode must be one of: shadow, act, autonomous/);
});

test('pr-maint rejects --pr without exactly one --repo, and a malformed --pr or --repo', () => {
  let result = cli('pr-maint', '--pr', '3');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--pr requires exactly one --repo/);

  result = cli('pr-maint', '--pr', 'abc', '--repo', 'me/a');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--pr must be a positive pull request number/);

  result = cli('pr-maint', '--repo', 'just-a-name');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--repo must be owner\/repo/);
});
