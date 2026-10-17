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

test('scrubEnv removes tokens and git config injected through the environment', () => {
  const env = scrubEnv({
    PATH: '/bin',
    GITHUB_TOKEN: 'ghp_secret',
    GH_TOKEN: 'ghp_secret',
    ...gitAuthEnv('ghp_secret')
  });
  assert.deepEqual(env, { PATH: '/bin' });
});

test('runGit resolves non-zero exits instead of throwing', async () => {
  const ok = await runGit(['--version'], { cwd: os.tmpdir() });
  assert.equal(ok.code, 0);
  assert.match(ok.stdout, /^git version/);

  const failed = await runGit(['rev-parse', '--verify', 'no-such-ref'], { cwd: os.tmpdir() });
  assert.notEqual(failed.code, 0);
});
