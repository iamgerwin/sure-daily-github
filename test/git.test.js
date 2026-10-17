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
