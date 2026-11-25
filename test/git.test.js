import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
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

test('runGit ignores ambient GIT_* variables that would redirect it to another repository', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-git-env-'));
  try {
    const outer = path.join(root, 'outer');
    const inner = path.join(root, 'inner');
    fs.mkdirSync(outer);
    fs.mkdirSync(inner);
    assert.equal((await runGit(['init', '-q'], { cwd: outer })).code, 0);

    // As inherited when the tool is launched from a git hook or `git -c` alias
    const baseEnv = {
      ...process.env,
      GIT_DIR: path.join(outer, '.git'),
      GIT_WORK_TREE: outer,
      GIT_CONFIG_PARAMETERS: "'user.name'='Injected'"
    };
    assert.equal((await runGit(['init', '-q'], { cwd: inner, baseEnv })).code, 0);
    assert.equal((await runGit(['config', 'user.name', 'Fixer'], { cwd: inner, baseEnv })).code, 0);

    const gitDir = await runGit(['rev-parse', '--absolute-git-dir'], { cwd: inner, baseEnv });
    assert.equal(fs.realpathSync(gitDir.stdout.trim()), fs.realpathSync(path.join(inner, '.git')));
    const name = await runGit(['config', 'user.name'], { cwd: inner, baseEnv });
    assert.equal(name.stdout.trim(), 'Fixer');
    // The caller's repository was never touched
    const outerName = await runGit(['config', '--local', 'user.name'], { cwd: outer });
    assert.notEqual(outerName.code, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runGit still applies GIT_* variables passed explicitly in env', async () => {
  const result = await runGit(['var', 'GIT_AUTHOR_IDENT'], {
    cwd: os.tmpdir(),
    baseEnv: { ...process.env, GIT_AUTHOR_NAME: 'Ambient', GIT_AUTHOR_EMAIL: 'ambient@example.com' },
    env: { GIT_AUTHOR_NAME: 'Explicit', GIT_AUTHOR_EMAIL: 'explicit@example.com' }
  });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /^Explicit <explicit@example\.com>/);
});
