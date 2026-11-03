import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));

function validate(dailyTarget, extra = [], general = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-cli-validate-'));
  const configFile = path.join(dir, 'config.yaml');
  fs.writeFileSync(configFile, [
    'general:',
    `  dailyTarget: ${dailyTarget}`,
    ...general,
    'repositories:',
    '  - owner: "me"',
    '    repo: "demo"',
    ...extra,
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

test('validate shows a fixed daily target as a single number', () => {
  const output = validate('3');
  assert.match(output, /^ {3}Daily target: 3$/m);
});

test('validate shows a daily target range as min-max', () => {
  const output = validate('{ min: 2, max: 5 }');
  assert.match(output, /^ {3}Daily target: 2-5$/m);
});

test('validate shows a range with equal bounds as a single number', () => {
  const output = validate('{ min: 4, max: 4 }');
  assert.match(output, /^ {3}Daily target: 4$/m);
});

const RANDOMIZATION = ['randomization:', '  enabled: true', '  issueCount: { min: 2, max: 4 }'];
const UNUSED = /^ {3}⚠️ {2}randomization\.issueCount and timeVariations are not used: /m;

test('validate warns that commit mode ignores randomized counts', () => {
  const output = validate('1', RANDOMIZATION);
  assert.match(output, /^ {3}Randomization: enabled$/m);
  assert.match(output, UNUSED);
  assert.match(output, /commit mode/);
});

test('validate warns that the advanced issue handler ignores randomized counts', () => {
  const output = validate('{ min: 2, max: 5 }', RANDOMIZATION, ['  mode: "issue"']);
  assert.match(output, UNUSED);
  assert.match(output, /advanced issue handler/);
});

test('validate does not warn when simple issue mode uses randomized counts', () => {
  const output = validate('1', RANDOMIZATION, ['  mode: "issue"']);
  assert.match(output, /^ {3}Randomization: enabled$/m);
  assert.doesNotMatch(output, UNUSED);
});
