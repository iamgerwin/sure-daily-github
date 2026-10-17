import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { runGit } from '../src/utils/git.js';
import { resolveConflicts } from '../src/core/conflict-resolver.js';

const IDENTITY = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com'];

async function git(cwd, args, date) {
  const env = date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {};
  const result = await runGit([...IDENTITY, ...args], { cwd, env });
  if (result.code !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function numbered(overrides = {}) {
  return Array.from({ length: 12 }, (_, i) => `${overrides[i + 1] ?? `line ${i + 1}`}\n`).join('');
}

async function commit(cwd, files, date, message = 'change') {
  for (const [file, content] of Object.entries(files)) {
    if (content === null) {
      await git(cwd, ['rm', '-q', file]);
    } else {
      fs.writeFileSync(path.join(cwd, file), content);
      await git(cwd, ['add', file]);
    }
  }
  await git(cwd, ['commit', '-q', '-m', message], date);
}

// base -> master and feature each change app.txt; returns the repo dir with
// feature checked out and master merged in (stopped on conflicts)
async function conflictedRepo(t, { base, master, feature }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-resolve-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await git(dir, ['init', '-q', '-b', 'master']);
  await commit(dir, base, '2025-12-01T00:00:00Z', 'base');
  await git(dir, ['branch', 'feature']);
  for (const [files, date] of master) await commit(dir, files, date);
  await git(dir, ['checkout', '-q', 'feature']);
  for (const [files, date] of feature) await commit(dir, files, date);

  const merge = await runGit([...IDENTITY, '-c', 'merge.conflictStyle=diff3', 'merge', '-q', '--no-ff', '--no-commit', 'master'], { cwd: dir });
  assert.notEqual(merge.code, 0, 'fixture must conflict');
  return dir;
}

test('resolveConflicts keeps the newer side for each hunk independently', async (t) => {
  const dir = await conflictedRepo(t, {
    base: { 'app.txt': numbered() },
    master: [
      [{ 'app.txt': numbered({ 10: 'master 10' }) }, '2026-01-15T00:00:00Z'],
      [{ 'app.txt': numbered({ 2: 'master 2', 10: 'master 10' }) }, '2026-02-15T00:00:00Z']
    ],
    feature: [
      [{ 'app.txt': numbered({ 2: 'feature 2' }) }, '2026-01-10T00:00:00Z'],
      [{ 'app.txt': numbered({ 2: 'feature 2', 10: 'feature 10' }) }, '2026-03-01T00:00:00Z']
    ]
  });

  const result = await resolveConflicts({ cwd: dir });

  assert.equal(result.resolved, true, result.reason);
  assert.deepEqual(result.files, [{ file: 'app.txt', hunks: ['theirs', 'ours'] }]);
  assert.equal(fs.readFileSync(path.join(dir, 'app.txt'), 'utf8'), numbered({ 2: 'master 2', 10: 'feature 10' }));
  assert.equal((await runGit(['ls-files', '-u'], { cwd: dir })).stdout, '');
});

test('resolveConflicts keeps a missing final newline byte-for-byte', async (t) => {
  const dir = await conflictedRepo(t, {
    base: { 'app.txt': 'base' },
    master: [[{ 'app.txt': 'master' }, '2026-02-01T00:00:00Z']],
    feature: [[{ 'app.txt': 'feature' }, '2026-01-01T00:00:00Z']]
  });

  const result = await resolveConflicts({ cwd: dir });

  assert.equal(result.resolved, true, result.reason);
  assert.equal(fs.readFileSync(path.join(dir, 'app.txt'), 'latin1'), 'master');
});

test('resolveConflicts keeps a final newline when the winning side has one', async (t) => {
  const dir = await conflictedRepo(t, {
    base: { 'app.txt': 'base\n' },
    master: [[{ 'app.txt': 'master\n' }, '2026-02-01T00:00:00Z']],
    feature: [[{ 'app.txt': 'feature\n' }, '2026-01-01T00:00:00Z']]
  });

  const result = await resolveConflicts({ cwd: dir });

  assert.equal(result.resolved, true, result.reason);
  assert.equal(fs.readFileSync(path.join(dir, 'app.txt'), 'latin1'), 'master\n');
});

test('resolveConflicts leaves a tie for manual review', async (t) => {
  const date = '2026-01-01T00:00:00Z';
  const dir = await conflictedRepo(t, {
    base: { 'app.txt': numbered() },
    master: [[{ 'app.txt': numbered({ 2: 'master 2' }) }, date]],
    feature: [[{ 'app.txt': numbered({ 2: 'feature 2' }) }, date]]
  });

  const result = await resolveConflicts({ cwd: dir });

  assert.equal(result.resolved, false);
  assert.match(result.reason, /same time on both sides/);
});

test('resolveConflicts refuses delete/modify conflicts', async (t) => {
  const dir = await conflictedRepo(t, {
    base: { 'app.txt': numbered() },
    master: [[{ 'app.txt': numbered({ 2: 'master 2' }) }, '2026-02-01T00:00:00Z']],
    feature: [[{ 'app.txt': null }, '2026-03-01T00:00:00Z']]
  });

  const result = await resolveConflicts({ cwd: dir });

  assert.equal(result.resolved, false);
  assert.match(result.reason, /deleted on one side/);
});

test('resolveConflicts refuses binary conflicts', async (t) => {
  const dir = await conflictedRepo(t, {
    base: { 'blob.bin': 'a\0base\n' },
    master: [[{ 'blob.bin': 'a\0master\n' }, '2026-02-01T00:00:00Z']],
    feature: [[{ 'blob.bin': 'a\0feature\n' }, '2026-03-01T00:00:00Z']]
  });

  const result = await resolveConflicts({ cwd: dir });

  assert.equal(result.resolved, false);
  assert.match(result.reason, /binary conflict/);
});

test('resolveConflicts refuses submodule conflicts', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-resolve-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await git(dir, ['init', '-q', '-b', 'master']);
  await commit(dir, { 'README.md': 'readme\n' }, '2025-12-01T00:00:00Z', 'base');
  const gitlink = async (sha, date) => {
    await git(dir, ['update-index', '--add', '--cacheinfo', `160000,${sha},sub`]);
    await git(dir, ['commit', '-q', '-m', 'sub'], date);
  };
  await gitlink('1111111111111111111111111111111111111111', '2025-12-02T00:00:00Z');
  await git(dir, ['branch', 'feature']);
  await gitlink('2222222222222222222222222222222222222222', '2026-01-01T00:00:00Z');
  await git(dir, ['checkout', '-q', 'feature']);
  await gitlink('3333333333333333333333333333333333333333', '2026-02-01T00:00:00Z');
  const merge = await runGit([...IDENTITY, 'merge', '-q', '--no-ff', '--no-commit', 'master'], { cwd: dir });
  assert.notEqual(merge.code, 0);

  const result = await resolveConflicts({ cwd: dir });

  assert.equal(result.resolved, false);
  assert.match(result.reason, /submodule conflict/);
});

test('resolveConflicts refuses a resolution that still contains markers', async (t) => {
  const dir = await conflictedRepo(t, {
    base: { 'app.txt': numbered() },
    master: [[{ 'app.txt': numbered({ 2: '=======' }) }, '2026-02-01T00:00:00Z']],
    feature: [[{ 'app.txt': numbered({ 2: 'feature 2' }) }, '2026-01-01T00:00:00Z']]
  });

  const result = await resolveConflicts({ cwd: dir });

  assert.equal(result.resolved, false);
  assert.match(result.reason, /conflict markers left/);
});
