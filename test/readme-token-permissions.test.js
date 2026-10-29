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

// Rows of the table under "#### Token permissions" in the README
function permissionRows() {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const section = readme.split('#### Token permissions')[1];
  assert.ok(section, 'README.md should have a Token permissions section');
  return section.split('\n\n').find(block => block.startsWith('| Command'))
    .split('\n').slice(2).map(row => row.split('|')[1]);
}

// A token missing a permission fails with a 403 at run time, so the table
// must say what every command needs
test('the README token permissions table covers every CLI command', () => {
  const commands = helpCommands();
  assert.ok(commands.includes('run') && commands.includes('pr-maint'), 'help should list the commands');
  const documented = new Set(permissionRows().flatMap(cell => [...cell.matchAll(/`([a-z][\w-]*)`/g)].map(m => m[1])));
  const missing = commands.filter(name => !documented.has(name));
  assert.deepEqual(missing, [], `README.md Token permissions is missing: ${missing.join(', ')}`);
});

test('the README token permissions table names both run modes', () => {
  const runRows = permissionRows().filter(cell => cell.includes('`run`'));
  assert.ok(runRows.some(cell => cell.includes('commit mode')));
  assert.ok(runRows.some(cell => cell.includes('issue mode')));
});
