import { execFile } from 'child_process';
import os from 'os';

export const DEFAULT_GIT_TIMEOUT_MS = 10 * 60 * 1000;

// The only variables code from the repository being tested may see; anything
// else (tokens, cloud credentials, injected git config) is dropped
const SAFE_ENV = /^(PATH|HOME|TMPDIR|TZ|LANG|LC_\w+|CI)$/;

// Runs git without a shell. Non-zero exits resolve ({ code, stdout, stderr }) so
// callers can branch on merge/push outcomes; spawn failures and timeouts reject.
// The user's global and system git config are ignored so hooks, rerere, signing
// or a custom merge driver cannot change what the fixer does.
export function runGit(args, { cwd, env = {}, baseEnv = process.env, timeoutMs = DEFAULT_GIT_TIMEOUT_MS, encoding = 'utf8' } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd,
      encoding,
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      env: {
        ...baseEnv,
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
