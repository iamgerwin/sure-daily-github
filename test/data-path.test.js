import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveDataPath, PROJECT_ROOT } from '../src/utils/data-path.js';
import { StateManager } from '../src/utils/state.js';
import AdvancedIssueHandler from '../src/github/advanced-issue-handler.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function withEnv(t, name, value) {
  const previous = process.env[name];
  process.env[name] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

test('PROJECT_ROOT is the repository root', () => {
  assert.equal(path.resolve(PROJECT_ROOT), root);
});

test('resolveDataPath anchors relative values to the project root and keeps absolute ones', () => {
  const fallback = path.join(root, 'data', 'state.json');
  assert.equal(resolveDataPath('state/custom.json', fallback), path.join(root, 'state', 'custom.json'));
  assert.equal(resolveDataPath('./custom.json', fallback), path.join(root, 'custom.json'));
  const absolute = path.join(os.tmpdir(), 'sdg-abs', 'state.json');
  assert.equal(resolveDataPath(absolute, fallback), absolute);
});

test('resolveDataPath trims whitespace and keeps the default for a blank or missing value', () => {
  const fallback = path.join(root, 'data', 'state.json');
  assert.equal(resolveDataPath('  custom.json \n', fallback), path.join(root, 'custom.json'));
  assert.equal(resolveDataPath('   ', fallback), fallback);
  assert.equal(resolveDataPath('', fallback), fallback);
  assert.equal(resolveDataPath(undefined, fallback), fallback);
});

test('a relative SDG_STATE_FILE resolves under the project root', (t) => {
  withEnv(t, 'SDG_STATE_FILE', ' sdg-test-missing/state.json ');
  const sm = new StateManager();
  assert.equal(sm.filePath, path.join(root, 'sdg-test-missing', 'state.json'));
});

test('an explicit filePath option still wins over SDG_STATE_FILE', (t) => {
  withEnv(t, 'SDG_STATE_FILE', 'sdg-test-missing/state.json');
  const filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-dp-')), 'state.json');
  t.after(() => fs.rmSync(path.dirname(filePath), { recursive: true, force: true }));
  assert.equal(new StateManager({ filePath }).filePath, filePath);
});

test('a relative SDG_ISSUE_STATE_FILE resolves under the project root', (t) => {
  withEnv(t, 'SDG_ISSUE_STATE_FILE', 'sdg-test-missing/issue-state.json');
  assert.equal(new AdvancedIssueHandler(null).stateFile, path.join(root, 'sdg-test-missing', 'issue-state.json'));
  process.env.SDG_ISSUE_STATE_FILE = ' ';
  assert.match(new AdvancedIssueHandler(null).stateFile, /data[\\/]issue-state\.json$/);
});

// The bug this guards: two processes started from different directories must
// agree on the state file, or each counts the daily target from zero
test('the state singleton uses the same file whatever the working directory', (t) => {
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-cwd-'));
  t.after(() => fs.rmSync(elsewhere, { recursive: true, force: true }));
  const stateUrl = pathToFileURL(path.join(root, 'src/utils/state.js')).href;
  const script = `import(${JSON.stringify(stateUrl)}).then(m => console.log(m.default.filePath))`;
  const read = (cwd) => execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, SDG_STATE_FILE: 'sdg-test-missing/state.json' }
  }).trim();

  const expected = path.join(root, 'sdg-test-missing', 'state.json');
  assert.equal(read(root), expected);
  assert.equal(read(elsewhere), expected);
});
