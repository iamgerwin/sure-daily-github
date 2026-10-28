import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));

function validate(dailyTarget) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-cli-validate-'));
  const configFile = path.join(dir, 'config.yaml');
  fs.writeFileSync(configFile, [
    'general:',
    `  dailyTarget: ${dailyTarget}`,
    'repositories:',
    '  - owner: "me"',
    '    repo: "demo"',
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
