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

test('detectTestCommand installs pnpm and yarn dependencies from their lockfiles', (t) => {
  const pnpm = repoDir(t, { 'package.json': pkg({ test: 'vitest run' }), 'pnpm-lock.yaml': "lockfileVersion: '9.0'\n" });
  assert.deepEqual(detectTestCommand(pnpm), { install: 'pnpm install --frozen-lockfile', test: 'npm test' });
  assert.deepEqual(detectTestCommand(pnpm, {}, { installDeps: false }), { install: null, test: 'npm test' });

  const yarn = repoDir(t, { 'package.json': pkg({ test: 'jest' }), 'yarn.lock': '# yarn lockfile v1\n' });
  assert.deepEqual(detectTestCommand(yarn), { install: 'yarn install --frozen-lockfile', test: 'npm test' });
  assert.deepEqual(
    detectTestCommand(yarn, { testCommand: 'yarn test:unit' }),
    { install: 'yarn install --frozen-lockfile', test: 'yarn test:unit' }
  );
});

test('detectTestCommand installs bun dependencies from a text or binary lockfile', (t) => {
  for (const lockfile of ['bun.lock', 'bun.lockb']) {
    const bun = repoDir(t, { 'package.json': pkg({ test: 'bun test' }), [lockfile]: '' });
    assert.deepEqual(detectTestCommand(bun), { install: 'bun install --frozen-lockfile', test: 'npm test' }, lockfile);
    assert.deepEqual(detectTestCommand(bun, {}, { installDeps: false }), { install: null, test: 'npm test' }, lockfile);
    assert.deepEqual(
      detectTestCommand(bun, { testCommand: 'bun test --bail' }),
      { install: 'bun install --frozen-lockfile', test: 'bun test --bail' },
      lockfile
    );
  }
});

test('detectTestCommand runs npm install without writing a lockfile when dependencies are declared but none is committed', (t) => {
  const install = 'npm install --no-package-lock --no-audit --no-fund';
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const unlocked = repoDir(t, {
      'package.json': JSON.stringify({ name: 'x', scripts: { test: 'mocha' }, [field]: { mocha: '^10.0.0' } })
    });
    assert.deepEqual(detectTestCommand(unlocked), { install, test: 'npm test' }, field);
    assert.deepEqual(detectTestCommand(unlocked, {}, { installDeps: false }), { install: null, test: 'npm test' }, field);
    assert.deepEqual(detectTestCommand(unlocked, { testCommand: 'npx mocha' }), { install, test: 'npx mocha' }, field);
  }

  const empty = repoDir(t, {
    'package.json': JSON.stringify({ name: 'x', scripts: { test: 'node --test' }, dependencies: {}, devDependencies: {} })
  });
  assert.deepEqual(detectTestCommand(empty), { install: null, test: 'npm test' });

  const locked = repoDir(t, {
    'package.json': JSON.stringify({ name: 'x', scripts: { test: 'jest' }, devDependencies: { jest: '^29.0.0' } }),
    'yarn.lock': ''
  });
  assert.deepEqual(detectTestCommand(locked), { install: 'yarn install --frozen-lockfile', test: 'npm test' });

  const makeOnly = repoDir(t, {
    'package.json': JSON.stringify({ name: 'x', devDependencies: { prettier: '^3.0.0' } }),
    Makefile: 'test:\n\techo ok\n'
  });
  assert.deepEqual(detectTestCommand(makeOnly), { install: null, test: 'make test' });
});

test('detectTestCommand prefers npm when a repo ships several lockfiles', (t) => {
  const mixed = repoDir(t, {
    'package.json': pkg({ test: 'node --test' }),
    'package-lock.json': '{}',
    'pnpm-lock.yaml': '',
    'yarn.lock': ''
  });
  assert.deepEqual(detectTestCommand(mixed), { install: 'npm ci', test: 'npm test' });

  const pnpmAndYarn = repoDir(t, { 'package.json': pkg({ test: 'node --test' }), 'pnpm-lock.yaml': '', 'yarn.lock': '' });
  assert.equal(detectTestCommand(pnpmAndYarn).install, 'pnpm install --frozen-lockfile');

  const yarnAndBun = repoDir(t, { 'package.json': pkg({ test: 'node --test' }), 'yarn.lock': '', 'bun.lock': '' });
  assert.equal(detectTestCommand(yarnAndBun).install, 'yarn install --frozen-lockfile');
});

test('detectTestCommand does not install for a Makefile-only repo with a lockfile', (t) => {
  const dir = repoDir(t, { 'yarn.lock': '', Makefile: 'test:\n\t./run\n' });
  assert.deepEqual(detectTestCommand(dir), { install: null, test: 'make test' });
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

test('runTestCommand returns when the command exits even if a background child holds its output open', async (t) => {
  const started = Date.now();
  const result = await runTestCommand('sleep 30 & echo done', { cwd: repoDir(t), env: process.env, timeoutMs: 20000 });
  assert.deepEqual(result, { code: 0, timedOut: false, output: 'done\n' });
  assert.ok(Date.now() - started < 10000, 'resolved without waiting for the background child');
});

test('runTestCommand kills processes the command left running after it exits', async (t) => {
  const dir = repoDir(t);
  const marker = path.join(dir, 'leftover-ran');
  const result = await runTestCommand(`(sleep 1; touch "${marker}") >/dev/null 2>&1 & echo done`, { cwd: dir, env: process.env, timeoutMs: 10000 });
  assert.deepEqual(result, { code: 0, timedOut: false, output: 'done\n' });
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.equal(fs.existsSync(marker), false);
});

test('tailLines keeps the last lines of output', () => {
  assert.equal(tailLines('a\nb\nc\n', 2), 'b\nc');
});
