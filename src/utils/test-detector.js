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

// The first lockfile found picks the install command, so npm keeps precedence
// in a repo that ships several. `npm ci` installs from either npm lockfile; a
// repo may ship only the shrinkwrap. Without an install, a pnpm or yarn repo
// runs its tests against a fresh clone with no node_modules and always fails.
// Bun writes a text bun.lock (1.2+) or a binary bun.lockb (older releases).
const LOCKFILE_INSTALLS = [
  ['package-lock.json', 'npm ci'],
  ['npm-shrinkwrap.json', 'npm ci'],
  ['pnpm-lock.yaml', 'pnpm install --frozen-lockfile'],
  ['yarn.lock', 'yarn install --frozen-lockfile'],
  ['bun.lock', 'bun install --frozen-lockfile'],
  ['bun.lockb', 'bun install --frozen-lockfile']
];

// Many libraries do not commit a lockfile; without an install their tests run
// against a fresh clone with no node_modules and always fail. --no-package-lock
// keeps the install from writing a lockfile into the work tree.
const UNLOCKED_NPM_INSTALL = 'npm install --no-package-lock --no-audit --no-fund';
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'];

function declaresDependencies(pkg) {
  return DEPENDENCY_FIELDS.some(field => {
    const deps = pkg?.[field];
    return deps && typeof deps === 'object' && Object.keys(deps).length > 0;
  });
}

function lockfileInstall(dir) {
  const locked = LOCKFILE_INSTALLS.find(([file]) => fs.existsSync(path.join(dir, file)))?.[1];
  if (locked) return locked;
  return declaresDependencies(readPackageJson(dir)) ? UNLOCKED_NPM_INSTALL : null;
}

// Toolchains whose manifest at the repository root implies a standard test
// command. Checked after npm and make, which a repo uses to wrap these.
const NATIVE_TEST_COMMANDS = [
  ['go.mod', 'go test ./...'],
  ['Cargo.toml', 'cargo test']
];

// Returns { install, test } shell commands, or null when the repository has no
// test suite we can run. A configured testCommand is used as-is, but still gets
// the dependency install a fresh clone needs.
export function detectTestCommand(dir, repoConfig = {}, { installDeps = true } = {}) {
  const install = installDeps ? lockfileInstall(dir) : null;
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

  // Go and Cargo fetch dependencies themselves, so there is no install step
  const native = NATIVE_TEST_COMMANDS.find(([file]) => fs.existsSync(path.join(dir, file)))?.[1];
  if (native) {
    return { install: null, test: native };
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
    // Decode on the stream so a multibyte character split across two reads is
    // not turned into U+FFFD (decoding each chunk on its own would)
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', append);
    child.stderr.on('data', append);

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child);
    }, clampTimerMs(timeoutMs));

    // Once the command itself exits, anything it left running in its group
    // (a backgrounded server or watcher) is an orphan: kill it so it cannot
    // keep stdout open and stall 'close' until the timeout, or touch the work
    // tree after the gate has passed
    child.on('exit', () => killGroup(child));
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
