import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

// Keep only the end of the output: that is where test runners print failures
const MAX_OUTPUT_CHARS = 64 * 1024;

function readPackageJson(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch (_) {
    return null;
  }
}

function hasMakeTestTarget(dir) {
  for (const name of ['GNUmakefile', 'makefile', 'Makefile']) {
    const file = path.join(dir, name);
    if (fs.existsSync(file) && /^test\s*:/m.test(fs.readFileSync(file, 'utf8'))) {
      return true;
    }
  }
  return false;
}

// Returns { install, test } shell commands, or null when the repository has no
// test suite we can run. A configured testCommand is used as-is.
export function detectTestCommand(dir, repoConfig = {}, { installDeps = true } = {}) {
  if (repoConfig.testCommand) {
    return { install: null, test: repoConfig.testCommand };
  }

  const testScript = readPackageJson(dir)?.scripts?.test;
  // `npm init` writes a stub test script that always fails
  if (typeof testScript === 'string' && testScript.trim() && !/no test specified/.test(testScript)) {
    const hasLockfile = fs.existsSync(path.join(dir, 'package-lock.json'));
    return { install: installDeps && hasLockfile ? 'npm ci' : null, test: 'npm test' };
  }

  if (hasMakeTestTarget(dir)) {
    return { install: null, test: 'make test' };
  }

  return null;
}

// Runs a shell command in its own process group so a timeout also kills the
// processes it spawned. Resolves { code, timedOut, output }; never rejects.
export function runTestCommand(command, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    let output = '';
    let timedOut = false;
    const append = (chunk) => {
      output = (output + chunk).slice(-MAX_OUTPUT_CHARS);
    };

    const child = spawn(command, { cwd, env, shell: true, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', append);
    child.stderr.on('data', append);

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (_) {
        // Already exited
      }
    }, timeoutMs);

    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: null, timedOut, output: `${output}${error.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut, output });
    });
  });
}

export function tailLines(text, count = 20) {
  return String(text ?? '').trimEnd().split('\n').slice(-count).join('\n');
}
