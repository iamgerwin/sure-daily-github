import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

// A manifest entry pointing at a missing file only fails once someone
// installs the package or imports it by name
test('package.json main, if declared, points to an existing file', () => {
  if (pkg.main === undefined) return;
  assert.ok(fs.existsSync(path.join(root, pkg.main)), `main points to missing file ${pkg.main}`);
});

test('package.json bin entries point to executable scripts with a node shebang', () => {
  const bins = typeof pkg.bin === 'string' ? { [pkg.name]: pkg.bin } : pkg.bin || {};
  assert.ok(Object.keys(bins).length > 0, 'expected at least one bin entry');
  for (const [name, target] of Object.entries(bins)) {
    const file = path.join(root, target);
    assert.ok(fs.existsSync(file), `bin ${name} points to missing file ${target}`);
    assert.match(fs.readFileSync(file, 'utf8'), /^#!\/usr\/bin\/env node\n/, `bin ${name} lacks a node shebang`);
  }
});
