import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runGit, gitAuthEnv } from '../src/utils/git.js';

// The guarantees runGit's comment promises the conflict fixer: the user's
// global and system git config cannot change what git does, the token header
// from gitAuthEnv is what git actually sees, and spawn failures and timeouts
// reject instead of resolving like a non-zero exit.

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-git-run-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A minimal environment so the developer's own git variables cannot leak in
function cleanEnv(home) {
  return { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') };
}

test('runGit ignores the global git config in HOME and XDG_CONFIG_HOME', async (t) => {
  const home = tmpDir(t);
  fs.writeFileSync(path.join(home, '.gitconfig'), '[user]\n\tname = from-home\n');
  fs.mkdirSync(path.join(home, '.config', 'git'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config', 'git', 'config'), '[user]\n\temail = from-xdg@example.com\n');
  const baseEnv = cleanEnv(home);

  const name = await runGit(['config', '--get', 'user.name'], { cwd: home, baseEnv });
  assert.equal(name.code, 1, 'user.name from ~/.gitconfig must not be read');
  assert.equal(name.stdout, '');
  const email = await runGit(['config', '--get', 'user.email'], { cwd: home, baseEnv });
  assert.equal(email.code, 1, 'user.email from $XDG_CONFIG_HOME/git/config must not be read');
});

test('runGit ignores a system git config even when GIT_CONFIG_SYSTEM points at one', async (t) => {
  const home = tmpDir(t);
  const systemFile = path.join(home, 'gitconfig-system');
  fs.writeFileSync(systemFile, '[core]\n\thooksPath = /tmp/planted-hooks\n');
  const baseEnv = { ...cleanEnv(home), GIT_CONFIG_SYSTEM: systemFile };

  const result = await runGit(['config', '--get', 'core.hooksPath'], { cwd: home, baseEnv });
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
});

test('the gitAuthEnv header is the http.extraheader git reads for github.com only', async (t) => {
  const home = tmpDir(t);
  const env = gitAuthEnv('ghp_secret');

  const github = await runGit(
    ['config', '--get-urlmatch', 'http.extraheader', 'https://github.com/owner/repo.git'],
    { cwd: home, baseEnv: cleanEnv(home), env }
  );
  assert.equal(github.code, 0);
  const encoded = github.stdout.trim().replace(/^AUTHORIZATION: basic /, '');
  assert.equal(Buffer.from(encoded, 'base64').toString(), 'x-access-token:ghp_secret');

  // Another host must not receive the token
  const other = await runGit(
    ['config', '--get-urlmatch', 'http.extraheader', 'https://example.com/owner/repo.git'],
    { cwd: home, baseEnv: cleanEnv(home), env }
  );
  assert.equal(other.code, 1);
  assert.equal(other.stdout, '');
});

test('runGit rejects when git cannot be started in the given directory', async (t) => {
  const missing = path.join(tmpDir(t), 'does-not-exist');
  await assert.rejects(runGit(['--version'], { cwd: missing }), (error) => {
    assert.equal(error.code, 'ENOENT');
    return true;
  });
});

test('runGit rejects a command that outlives its timeout instead of resolving it', async (t) => {
  const home = tmpDir(t);
  // hash-object --stdin waits for stdin, which execFile never closes
  await assert.rejects(
    runGit(['hash-object', '--stdin'], { cwd: home, baseEnv: cleanEnv(home), timeoutMs: 200 }),
    (error) => {
      assert.equal(error.killed, true);
      assert.equal(error.signal, 'SIGTERM');
      return true;
    }
  );
});

test('runGit returns raw bytes when asked for buffer output', async (t) => {
  const repo = tmpDir(t);
  const baseEnv = cleanEnv(repo);
  assert.equal((await runGit(['init', '-q'], { cwd: repo, baseEnv })).code, 0);
  // Not valid UTF-8: decoding it as text would replace the bytes with U+FFFD
  const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x80]);
  fs.writeFileSync(path.join(repo, 'blob.bin'), bytes);
  const hashed = await runGit(['hash-object', '-w', 'blob.bin'], { cwd: repo, baseEnv });
  assert.equal(hashed.code, 0);

  const result = await runGit(['cat-file', 'blob', hashed.stdout.trim()], { cwd: repo, baseEnv, encoding: 'buffer' });
  assert.equal(result.code, 0);
  assert.ok(Buffer.isBuffer(result.stdout));
  assert.deepEqual(result.stdout, bytes);
});
