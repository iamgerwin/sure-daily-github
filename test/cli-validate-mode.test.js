import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describeRunMode } from '../src/core/executor.js';

const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));

function validate(general = [], repo = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-cli-validate-mode-'));
  const configFile = path.join(dir, 'config.yaml');
  fs.writeFileSync(configFile, [
    'general:',
    '  dailyTarget: 1',
    ...general,
    'repositories:',
    '  - owner: "me"',
    '    repo: "demo"',
    ...repo,
    ''
  ].join('\n'));

  try {
    return execFileSync(process.execPath, [cliPath, 'validate', '--config', configFile], {
      env: { ...process.env, GITHUB_TOKEN: 'ghp_test', LOG_LEVEL: 'error' },
      encoding: 'utf8'
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const repo = (fields = {}) => ({ owner: 'me', repo: 'demo', enabled: true, dailyTarget: { min: 1, max: 1 }, intervalMinutes: null, ...fields });

test('describeRunMode defaults to commit mode', () => {
  assert.equal(describeRunMode({ general: {}, repositories: [repo()] }), 'commit');
});

test('describeRunMode names the simple issue handler for fixed targets', () => {
  assert.equal(describeRunMode({ general: { mode: 'issue' }, repositories: [repo()] }), 'issue (simple issue handler)');
});

test('describeRunMode names the advanced issue handler for a target range or interval', () => {
  const range = { general: { mode: 'issue' }, repositories: [repo({ dailyTarget: { min: 2, max: 5 } })] };
  const interval = { general: { mode: 'issue' }, repositories: [repo({ intervalMinutes: { min: 30, max: 60 } })] };
  assert.equal(describeRunMode(range), 'issue (advanced issue handler)');
  assert.equal(describeRunMode(interval), 'issue (advanced issue handler)');
});

test('describeRunMode ignores disabled repositories when naming the handler', () => {
  const cfg = { general: { mode: 'issue' }, repositories: [repo(), repo({ enabled: false, intervalMinutes: { min: 30, max: 60 } })] };
  assert.equal(describeRunMode(cfg), 'issue (simple issue handler)');
});

test('describeRunMode calls out a dryRun left on in the config', () => {
  assert.equal(
    describeRunMode({ general: { mode: 'commit', dryRun: true }, repositories: [repo()] }),
    'commit, dry run (nothing is written to GitHub)'
  );
});

test('validate prints the commit mode by default', () => {
  assert.match(validate(), /^ {3}Mode: commit$/m);
});

test('validate prints the issue handler run will use', () => {
  assert.match(validate(['  mode: issue']), /^ {3}Mode: issue \(simple issue handler\)$/m);
  assert.match(
    validate(['  mode: issue'], ['    intervalMinutes: { min: 30, max: 60 }']),
    /^ {3}Mode: issue \(advanced issue handler\)$/m
  );
});

test('validate warns when dryRun is on in the config file', () => {
  assert.match(validate(['  dryRun: true']), /^ {3}Mode: commit, dry run \(nothing is written to GitHub\)$/m);
});
