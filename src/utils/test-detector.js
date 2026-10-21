import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { clampTimerMs } from './process.js';

// Keep only the end of the output: that is where test runners print failures
const MAX_OUTPUT_CHARS = 64 * 1024;

function readPackageJson(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch (_) {
    return null;
  }
}

// A rule line whose target list includes `test` (`test:`, `test::`, `unit test:`),
// but not a variable assignment such as `test := ...` or `test ::= ...`
const MAKE_TEST_RULE = /^(?:[^\s:#=]+[ \t]+)*test(?:[ \t]+[^\s:#=]+)*[ \t]*::?(?![:=])/m;

function hasMakeTestTarget(dir) {
  // make reads only the first of these that exists, so a test target in a
  // later one is never reachable by `make test`
  const name = ['GNUmakefile', 'makefile', 'Makefile'].find(file => fs.existsSync(path.join(dir, file)));
  return Boolean(name) && MAKE_TEST_RULE.test(fs.readFileSync(path.join(dir, name), 'utf8'));
}

// `npm ci` installs from either lockfile; npm-shrinkwrap.json takes precedence
// when both exist, but a repo may ship only the shrinkwrap
const NPM_LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json'];

function hasNpmLockfile(dir) {
  return NPM_LOCKFILES.some(file => fs.existsSync(path.join(dir, file)));
}

// Returns { install, test } shell commands, or null when the repository has no
// test suite we can run. A configured testCommand is used as-is, but still gets
// the dependency install a fresh clone needs.
export function detectTestCommand(dir, repoConfig = {}, { installDeps = true } = {}) {
  const install = installDeps && hasNpmLockfile(dir) ? 'npm ci' : null;
  if (repoConfig.testCommand) {
    return { install, test: repoConfig.testCommand };
  }

  const testScript = readPackageJson(dir)?.scripts?.test;
  // `npm init` writes a stub test script that always fails
  if (typeof testScript === 'string' && testScript.trim() && !/no test specified/.test(testScript)) {
    return { install, test: 'npm test' };
  }

  if (hasMakeTestTarget(dir)) {
    return { install: null, test: 'make test' };
  }

  return null;
}

// Process groups of commands still running, so an interrupted run can kill them
const activeChildren = new Set();

function killGroup(child) {
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch (_) {
    // Already exited
  }
}

export function killActiveTests() {
  for (const child of activeChildren) killGroup(child);
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
    activeChildren.add(child);
    child.stdout.on('data', append);
    child.stderr.on('data', append);

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child);
    }, clampTimerMs(timeoutMs));

    child.on('error', (error) => {
      clearTimeout(timer);
      activeChildren.delete(child);
      resolve({ code: null, timedOut, output: `${output}${error.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      activeChildren.delete(child);
      resolve({ code, timedOut, output });
    });
  });
}

export function tailLines(text, count = 20) {
  return String(text ?? '').trimEnd().split('\n').slice(-count).join('\n');
}
