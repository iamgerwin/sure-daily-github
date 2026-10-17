import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { detectTestCommand, runTestCommand, tailLines } from '../src/utils/test-detector.js';

function repoDir(t, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-detect-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [file, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, file), content);
  }
  return dir;
}

const pkg = (scripts) => JSON.stringify({ name: 'x', scripts });

test('detectTestCommand prefers the configured testCommand', (t) => {
  const dir = repoDir(t, { 'package.json': pkg({ test: 'node --test' }) });
  assert.deepEqual(detectTestCommand(dir, { testCommand: 'make check' }), { install: null, test: 'make check' });
});

test('detectTestCommand uses npm test, installing only when a lockfile exists', (t) => {
  const plain = repoDir(t, { 'package.json': pkg({ test: 'node --test' }) });
  assert.deepEqual(detectTestCommand(plain), { install: null, test: 'npm test' });

  const locked = repoDir(t, { 'package.json': pkg({ test: 'node --test' }), 'package-lock.json': '{}' });
  assert.deepEqual(detectTestCommand(locked), { install: 'npm ci', test: 'npm test' });
  assert.deepEqual(detectTestCommand(locked, {}, { installDeps: false }), { install: null, test: 'npm test' });
});

test('detectTestCommand ignores the npm init stub test script', (t) => {
  const dir = repoDir(t, { 'package.json': pkg({ test: 'echo "Error: no test specified" && exit 1' }) });
  assert.equal(detectTestCommand(dir), null);
});

test('detectTestCommand falls back to a Makefile test target', (t) => {
  const dir = repoDir(t, { 'package.json': '{not json', Makefile: 'build:\n\tcc x.c\n\ntest: build\n\t./run\n' });
  assert.deepEqual(detectTestCommand(dir), { install: null, test: 'make test' });
});

test('detectTestCommand returns null without a runnable suite', (t) => {
  assert.equal(detectTestCommand(repoDir(t, { Makefile: 'build:\n\tcc x.c\n' })), null);
  assert.equal(detectTestCommand(repoDir(t)), null);
});

test('runTestCommand reports exit code and output', async (t) => {
  const dir = repoDir(t);
  const ok = await runTestCommand('echo hello', { cwd: dir, env: process.env, timeoutMs: 10000 });
  assert.deepEqual(ok, { code: 0, timedOut: false, output: 'hello\n' });

  const failed = await runTestCommand('echo boom >&2; exit 3', { cwd: dir, env: process.env, timeoutMs: 10000 });
  assert.equal(failed.code, 3);
  assert.equal(failed.output, 'boom\n');
});

test('runTestCommand kills a command that exceeds the timeout', async (t) => {
  const result = await runTestCommand('sleep 30', { cwd: repoDir(t), env: process.env, timeoutMs: 100 });
  assert.equal(result.timedOut, true);
  assert.notEqual(result.code, 0);
});

test('tailLines keeps the last lines of output', () => {
  assert.equal(tailLines('a\nb\nc\n', 2), 'b\nc');
});
