import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Command names from the "Commands:" block of the top-level help
function helpCommands() {
  const result = spawnSync(process.execPath, [path.join(root, 'src/cli.js'), '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  const block = result.stdout.split('Commands:\n')[1];
  return [...block.matchAll(/^ {2}([a-z][\w-]*)/gm)].map(m => m[1]).filter(name => name !== 'help');
}

// Command names from the code block under "## CLI Commands" in the README
function readmeCommands() {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const section = readme.split('## CLI Commands')[1];
  const block = section.split('```')[1];
  return [...block.matchAll(/^sure-daily-github ([a-z][\w-]*)/gm)].map(m => m[1]);
}

test('the README CLI Commands list documents every CLI command', () => {
  const commands = helpCommands();
  assert.ok(commands.includes('run') && commands.includes('pr-maint'), 'help should list the commands');
  const documented = readmeCommands();
  const missing = commands.filter(name => !documented.includes(name));
  assert.deepEqual(missing, [], `README.md CLI Commands is missing: ${missing.join(', ')}`);
});

test('the README CLI Commands list documents no unknown command', () => {
  const commands = helpCommands();
  const unknown = readmeCommands().filter(name => !commands.includes(name));
  assert.deepEqual(unknown, []);
});

// --config is covered by the prose under the list, and --once is a no-op
// (a single pass is already the default), so neither has to be on each line
const UNLISTED_FLAGS = new Set(['--config', '--help', '--once']);

// Long flags from the "Options:" block of a command's help
function helpFlags(command) {
  const result = spawnSync(process.execPath, [path.join(root, 'src/cli.js'), command, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  const block = result.stdout.split('Options:\n')[1];
  return [...block.matchAll(/^ {2}(?:-\w, )?(--[\w-]+)/gm)].map(m => m[1]).filter(flag => !UNLISTED_FLAGS.has(flag));
}

// Long flags on a command's line in the README CLI Commands block
function readmeFlags(command) {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const block = readme.split('## CLI Commands')[1].split('```')[1];
  const line = block.split('\n').find(l => l.startsWith(`sure-daily-github ${command} `) || l === `sure-daily-github ${command}`);
  const usage = line.split('#')[0];
  return [...usage.matchAll(/(--[\w-]+)/g)].map(m => m[1]);
}

test('the README CLI Commands list documents every option of each command', () => {
  for (const command of helpCommands()) {
    const documented = readmeFlags(command);
    const missing = helpFlags(command).filter(flag => !documented.includes(flag));
    assert.deepEqual(missing, [], `README.md CLI Commands is missing ${command} ${missing.join(', ')}`);
  }
});

test('the README CLI Commands list documents no unknown option', () => {
  for (const command of helpCommands()) {
    const options = helpFlags(command);
    const unknown = readmeFlags(command).filter(flag => !options.includes(flag));
    assert.deepEqual(unknown, [], `README.md CLI Commands lists unknown ${command} ${unknown.join(', ')}`);
  }
});
