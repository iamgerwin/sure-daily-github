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

test('detectTestCommand still installs dependencies for a configured testCommand', (t) => {
  const locked = repoDir(t, { 'package.json': pkg({ test: 'node --test' }), 'package-lock.json': '{}' });
  const repo = { testCommand: 'npm run test:unit' };
  assert.deepEqual(detectTestCommand(locked, repo, { installDeps: true }), { install: 'npm ci', test: 'npm run test:unit' });
  assert.deepEqual(detectTestCommand(locked, repo, { installDeps: false }), { install: null, test: 'npm run test:unit' });

  const unlocked = repoDir(t, { 'package.json': pkg({ test: 'node --test' }) });
  assert.deepEqual(detectTestCommand(unlocked, repo, { installDeps: true }), { install: null, test: 'npm run test:unit' });
});

test('detectTestCommand uses npm test, installing only when a lockfile exists', (t) => {
  const plain = repoDir(t, { 'package.json': pkg({ test: 'node --test' }) });
  assert.deepEqual(detectTestCommand(plain), { install: null, test: 'npm test' });

  const locked = repoDir(t, { 'package.json': pkg({ test: 'node --test' }), 'package-lock.json': '{}' });
  assert.deepEqual(detectTestCommand(locked), { install: 'npm ci', test: 'npm test' });
  assert.deepEqual(detectTestCommand(locked, {}, { installDeps: false }), { install: null, test: 'npm test' });
});

test('detectTestCommand installs from an npm-shrinkwrap.json without a package-lock.json', (t) => {
  const shrinkwrapped = repoDir(t, { 'package.json': pkg({ test: 'node --test' }), 'npm-shrinkwrap.json': '{}' });
  assert.deepEqual(detectTestCommand(shrinkwrapped), { install: 'npm ci', test: 'npm test' });
  assert.deepEqual(detectTestCommand(shrinkwrapped, {}, { installDeps: false }), { install: null, test: 'npm test' });
  assert.deepEqual(
    detectTestCommand(shrinkwrapped, { testCommand: 'npm run test:unit' }),
    { install: 'npm ci', test: 'npm run test:unit' }
  );
});

test('detectTestCommand ignores the npm init stub test script', (t) => {
  const dir = repoDir(t, { 'package.json': pkg({ test: 'echo "Error: no test specified" && exit 1' }) });
  assert.equal(detectTestCommand(dir), null);
});

test('detectTestCommand falls back to a Makefile test target', (t) => {
  const dir = repoDir(t, { 'package.json': '{not json', Makefile: 'build:\n\tcc x.c\n\ntest: build\n\t./run\n' });
  assert.deepEqual(detectTestCommand(dir), { install: null, test: 'make test' });
});

test('detectTestCommand finds test in a multi-target or double-colon rule', (t) => {
  for (const rule of ['unit test: build', 'test lint:', 'test::', 'test :']) {
    const dir = repoDir(t, { Makefile: `build:\n\tcc x.c\n\n${rule}\n\t./run\n` });
    assert.deepEqual(detectTestCommand(dir), { install: null, test: 'make test' }, rule);
  }
});

test('detectTestCommand ignores test variables, prerequisites, and similar names', (t) => {
  for (const line of ['test := 1', 'test ::= 1', 'test:=1', 'test-unit:', 'mytest:', '.PHONY: test', '# test:', 'all:\n\ttest: x']) {
    const dir = repoDir(t, { Makefile: `${line}\n` });
    assert.equal(detectTestCommand(dir), null, line);
  }
});

test('detectTestCommand reads only the makefile that make itself would use', (t) => {
  const shadowed = repoDir(t, { GNUmakefile: 'build:\n\tcc x.c\n', Makefile: 'test:\n\t./run\n' });
  assert.equal(detectTestCommand(shadowed), null);

  const gnu = repoDir(t, { GNUmakefile: 'test:\n\t./run\n', Makefile: 'build:\n\tcc x.c\n' });
  assert.deepEqual(detectTestCommand(gnu), { install: null, test: 'make test' });
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

test('runTestCommand does not kill a command when the timeout exceeds the timer limit', async (t) => {
  // 25 days in ms overflows a 32-bit timer delay, which Node turns into 1ms
  const result = await runTestCommand('sleep 0.3; echo done', { cwd: repoDir(t), env: process.env, timeoutMs: 25 * 24 * 60 * 60 * 1000 });
  assert.deepEqual(result, { code: 0, timedOut: false, output: 'done\n' });
});

test('runTestCommand keeps a multibyte character split across two writes intact', async (t) => {
  // "✓" is e2 9c 93; the pause makes the two halves arrive as separate chunks
  const script = 'process.stdout.write(Buffer.from([0xe2, 0x9c])); setTimeout(() => process.stdout.write(Buffer.from([0x93, 0x0a])), 100)';
  const result = await runTestCommand(`"${process.execPath}" -e "${script}"`, { cwd: repoDir(t), env: process.env, timeoutMs: 10000 });
  assert.equal(result.code, 0);
  assert.equal(result.output, '✓\n');
});

test('tailLines keeps the last lines of output', () => {
  assert.equal(tailLines('a\nb\nc\n', 2), 'b\nc');
});
