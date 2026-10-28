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
