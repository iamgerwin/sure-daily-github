import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { runGit, gitAuthEnv, scrubEnv } from '../src/utils/git.js';

test('gitAuthEnv passes the token as a GitHub-scoped header, not in plain text', () => {
  const env = gitAuthEnv('ghp_secret');
  assert.equal(env.GIT_CONFIG_COUNT, '1');
  assert.equal(env.GIT_CONFIG_KEY_0, 'http.https://github.com/.extraheader');
  assert.equal(JSON.stringify(env).includes('ghp_secret'), false);
  const encoded = env.GIT_CONFIG_VALUE_0.replace('AUTHORIZATION: basic ', '');
  assert.equal(Buffer.from(encoded, 'base64').toString(), 'x-access-token:ghp_secret');
});

test('scrubEnv keeps only allowlisted variables', () => {
  const env = scrubEnv({
    PATH: '/bin',
    HOME: '/home/me',
    LANG: 'C.UTF-8',
    LC_ALL: 'C',
    GITHUB_TOKEN: 'ghp_secret',
    GH_TOKEN: 'ghp_secret',
    NPM_TOKEN: 'npm_secret',
    AWS_SECRET_ACCESS_KEY: 'aws_secret',
    ...gitAuthEnv('ghp_secret')
  });
  assert.deepEqual(env, { PATH: '/bin', HOME: '/home/me', LANG: 'C.UTF-8', LC_ALL: 'C' });
});

test('runGit resolves non-zero exits instead of throwing', async () => {
  const ok = await runGit(['--version'], { cwd: os.tmpdir() });
  assert.equal(ok.code, 0);
  assert.match(ok.stdout, /^git version/);

  const failed = await runGit(['rev-parse', '--verify', 'no-such-ref'], { cwd: os.tmpdir() });
  assert.notEqual(failed.code, 0);
});

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-git-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('runGit works in cwd even when the environment points git at another repository', async (t) => {
  const root = tmpDir(t);
  const outer = path.join(root, 'outer');
  const work = path.join(root, 'work');
  fs.mkdirSync(outer);
  fs.mkdirSync(work);
  assert.equal((await runGit(['init', '-q'], { cwd: outer })).code, 0);

  // What git exports to a hook running in `outer`, plus injected config
  const baseEnv = {
    ...process.env,
    GIT_DIR: path.join(outer, '.git'),
    GIT_WORK_TREE: outer,
    GIT_INDEX_FILE: path.join(outer, '.git', 'index'),
    GIT_CONFIG_PARAMETERS: "'user.name'='injected'",
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'user.email',
    GIT_CONFIG_VALUE_0: 'injected@example.com'
  };

  assert.equal((await runGit(['init', '-q'], { cwd: work, baseEnv })).code, 0);
  assert.equal((await runGit(['config', 'user.name', 'fixer'], { cwd: work, baseEnv })).code, 0);

  assert.equal(fs.existsSync(path.join(work, '.git')), true);
  const outerName = await runGit(['config', '--local', 'user.name'], { cwd: outer });
  assert.notEqual(outerName.code, 0, 'outer repository config must stay untouched');
  assert.equal((await runGit(['config', 'user.name'], { cwd: work, baseEnv })).stdout.trim(), 'fixer');
  // The injected GIT_CONFIG_* pair is dropped along with GIT_CONFIG_PARAMETERS
  assert.notEqual((await runGit(['config', 'user.email'], { cwd: work, baseEnv })).code, 0);
});

test('runGit still applies repository variables the caller passes explicitly', async (t) => {
  const root = tmpDir(t);
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  assert.equal((await runGit(['init', '-q'], { cwd: repo })).code, 0);

  const result = await runGit(['rev-parse', '--absolute-git-dir'], {
    cwd: root,
    env: { GIT_DIR: path.join(repo, '.git') }
  });
  assert.equal(result.code, 0);
  assert.equal(fs.realpathSync(result.stdout.trim()), fs.realpathSync(path.join(repo, '.git')));
});
