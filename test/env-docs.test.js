import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function listFiles(dir, ext) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listFiles(full, ext);
    return entry.name.endsWith(ext) ? [full] : [];
  });
}

function envVarsReadBySource() {
  const names = new Set();
  for (const file of listFiles(path.join(root, 'src'), '.js')) {
    for (const match of fs.readFileSync(file, 'utf8').matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) {
      names.add(match[1]);
    }
  }
  return [...names].sort();
}

// An override nobody can find is as good as none: every variable the code
// reads must be named in the README, a doc, or .env.example
test('every environment variable read by src/ is documented', () => {
  const docs = [
    path.join(root, 'README.md'),
    path.join(root, '.env.example'),
    ...listFiles(path.join(root, 'docs'), '.md')
  ].map(file => fs.readFileSync(file, 'utf8')).join('\n');

  const vars = envVarsReadBySource();
  assert.ok(vars.length > 0, 'expected src/ to read at least one environment variable');
  const undocumented = vars.filter(name => !new RegExp(`\\b${name}\\b`).test(docs));
  assert.deepEqual(undocumented, []);
});
