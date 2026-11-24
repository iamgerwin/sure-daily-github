import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-push-gate-'));
process.env.SDG_RUN_LOCK_FILE = path.join(lockDir, 'run.lock');
process.env.SDG_CONFLICT_FIXER_STATE_FILE = path.join(lockDir, 'conflict-fixer-state.json');

const { isFreshPushConfig, pushConfigListArgs, distinctRepoCount } = await import('../src/core/conflict-fixer.js');
const { runGit } = await import('../src/utils/git.js');

test.after(() => fs.rmSync(lockDir, { recursive: true, force: true }));

// The same args conflict-fixer.js and babysitter.js list the push repository with
function listPushConfig(pushDir) {
  return runGit(pushConfigListArgs(pushDir), { cwd: pushDir });
}

async function initBare(t) {
  const pushDir = fs.mkdtempSync(path.join(lockDir, 'sdg-push-'));
  t.after(() => fs.rmSync(pushDir, { recursive: true, force: true }));
  const init = await runGit(['init', '-q', '--bare', pushDir], { cwd: pushDir });
  assert.equal(init.code, 0, init.stderr);
  return pushDir;
}

// Proves the listing itself succeeded and shows the planted key, so a false
// from the gate comes from that key rather than from a failed listing
async function listPlanted(pushDir, plantedKey) {
  const listed = await listPushConfig(pushDir);
  assert.equal(listed.code, 0, listed.stderr);
  assert.ok(listed.stdout.split('\n').includes(plantedKey.toLowerCase()),
    `expected ${plantedKey} in the listing:\n${listed.stdout}`);
  return listed;
}

test('the config of a freshly initialized bare repository passes the push gate', async (t) => {
  const pushDir = await initBare(t);
  const listed = await listPushConfig(pushDir);
  assert.equal(listed.code, 0, listed.stderr);
  assert.equal(isFreshPushConfig(listed), true, `unexpected keys from git init --bare:\n${listed.stdout}`);
});

for (const [key, value] of [
  ['core.hooksPath', '/tmp/planted-hooks'],
  ['core.fsmonitor', 'touch /tmp/pwned'],
  ['core.sshCommand', 'sh -c planted'],
  ['credential.helper', '!planted'],
  ['url.ext::sh -c planted.insteadOf', 'https://github.com/'],
  ['http.extraHeader', 'X-Planted: 1'],
  ['remote.origin.url', 'https://evil.example/repo.git']
]) {
  test(`a push repository with a planted ${key} fails the push gate`, async (t) => {
    const pushDir = await initBare(t);
    const set = await runGit(['config', '--file', path.join(pushDir, 'config'), key, value], { cwd: pushDir });
    assert.equal(set.code, 0, set.stderr);
    assert.equal(isFreshPushConfig(await listPlanted(pushDir, key)), false);
  });
}

test('a planted [include] or [includeIf] section fails the push gate', async (t) => {
  const pushDir = await initBare(t);
  fs.appendFileSync(path.join(pushDir, 'config'), '[include]\n\tpath = /tmp/planted.gitconfig\n');
  assert.equal(isFreshPushConfig(await listPlanted(pushDir, 'include.path')), false);

  const other = await initBare(t);
  fs.appendFileSync(path.join(other, 'config'), '[includeIf "gitdir:/"]\n\tpath = /tmp/planted.gitconfig\n');
  assert.equal(isFreshPushConfig(await listPlanted(other, 'includeIf.gitdir:/.path')), false);
});

test('an unreadable push repository config fails the push gate', async (t) => {
  const pushDir = await initBare(t);
  fs.writeFileSync(path.join(pushDir, 'config'), '[core\n\tbare = true\n');
  const listed = await listPushConfig(pushDir);
  assert.notEqual(listed.code, 0);
  assert.equal(isFreshPushConfig(listed), false);

  // git exits non-zero (128) when the --file config does not exist, so the gate
  // rejects an absent config through its failed-listing check
  fs.rmSync(path.join(pushDir, 'config'));
  const missing = await listPushConfig(pushDir);
  assert.notEqual(missing.code, 0, `git listed a missing config file:\n${missing.stdout}`);
  assert.equal(isFreshPushConfig(missing), false);
});

test('isFreshPushConfig accepts only known init keys, in any case, and rejects a failed listing', () => {
  assert.equal(isFreshPushConfig({ code: 0, stdout: '' }), true);
  assert.equal(isFreshPushConfig({
    code: 0,
    stdout: 'core.repositoryformatversion\ncore.filemode\ncore.bare\ncore.logallrefupdates\n'
      + 'core.ignorecase\ncore.precomposeunicode\ncore.symlinks\n'
  }), true);
  assert.equal(isFreshPushConfig({ code: 0, stdout: 'core.repositoryFormatVersion\nCORE.BARE\n' }), true);
  // A config listing that ends without a newline still has every key checked
  assert.equal(isFreshPushConfig({ code: 0, stdout: 'core.bare\ncore.hookspath' }), false);
  assert.equal(isFreshPushConfig({ code: 0, stdout: 'core.bare\ncore.hookspath\n' }), false);
  assert.equal(isFreshPushConfig({ code: 1, stdout: '' }), false);
  assert.equal(isFreshPushConfig({ code: 128, stdout: 'core.bare\n' }), false);
});

test('distinctRepoCount counts owner/repo names case-insensitively, once each', () => {
  assert.equal(distinctRepoCount(), 0);
  assert.equal(distinctRepoCount([]), 0);
  assert.equal(distinctRepoCount(['me/demo']), 1);
  assert.equal(distinctRepoCount(['me/demo', 'Me/Demo', 'ME/DEMO']), 1);
  assert.equal(distinctRepoCount(['me/demo', 'me/other']), 2);
  assert.equal(distinctRepoCount(['me/demo', 'you/demo', 'Me/Demo']), 2);
});
