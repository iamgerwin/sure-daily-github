import { execFile } from 'child_process';
import os from 'os';

export const DEFAULT_GIT_TIMEOUT_MS = 10 * 60 * 1000;

// The only variables code from the repository being tested may see; anything
// else (tokens, cloud credentials, injected git config) is dropped
const SAFE_ENV = /^(PATH|HOME|TMPDIR|TZ|LANG|LC_\w+|CI)$/;

// Variables that tell git which repository to use or inject config into it
// (`git rev-parse --local-env-vars`, plus the numbered GIT_CONFIG_KEY_n /
// GIT_CONFIG_VALUE_n pairs). Git exports GIT_DIR, GIT_WORK_TREE and
// GIT_INDEX_FILE to hooks, so a run started from one (or with GIT_DIR in its
// environment) would otherwise init, configure and merge in that repository
// instead of the directory given as `cwd`.
const REPO_ENV = /^GIT_(ALTERNATE_OBJECT_DIRECTORIES|CONFIG|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+|OBJECT_DIRECTORY|DIR|WORK_TREE|IMPLICIT_WORK_TREE|GRAFT_FILE|INDEX_FILE|NO_REPLACE_OBJECTS|REPLACE_REF_BASE|PREFIX|SHALLOW_FILE|COMMON_DIR)$/;

function withoutRepoEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !REPO_ENV.test(key)));
}

// Runs git without a shell. Non-zero exits resolve ({ code, stdout, stderr }) so
// callers can branch on merge/push outcomes; spawn failures and timeouts reject.
// The user's global and system git config are ignored so hooks, rerere, signing
// or a custom merge driver cannot change what the fixer does. Repository and
// config variables inherited from `baseEnv` are dropped so git always works on
// `cwd`; a caller that means to set one passes it in `env`.
export function runGit(args, { cwd, env = {}, baseEnv = process.env, timeoutMs = DEFAULT_GIT_TIMEOUT_MS, encoding = 'utf8' } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd,
      encoding,
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      env: {
        ...withoutRepoEnv(baseEnv),
        GIT_CONFIG_GLOBAL: os.devNull,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
        ...env
      }
    }, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') {
        reject(error);
        return;
      }
      resolve({ code: error ? error.code : 0, stdout, stderr });
    });
  });
}

// Passes the token as an HTTP header through git's env-based config so it never
// lands in a remote URL, .git/config, the process list, or logs
export function gitAuthEnv(token) {
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`
  };
}

export function scrubEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => SAFE_ENV.test(key)));
}
