import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defaultConfigPath } from '../src/config/loader.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function withConfigPath(t, value) {
  const saved = process.env.CONFIG_PATH;
  t.after(() => {
    if (saved === undefined) delete process.env.CONFIG_PATH;
    else process.env.CONFIG_PATH = saved;
  });
  if (value === undefined) delete process.env.CONFIG_PATH;
  else process.env.CONFIG_PATH = value;
}

test('without CONFIG_PATH the config is config/config.yaml in the project root', (t) => {
  withConfigPath(t, undefined);
  assert.equal(defaultConfigPath(), path.join(root, 'config/config.yaml'));
});

test('a blank or whitespace-only CONFIG_PATH falls back to the default', (t) => {
  for (const value of ['', '   ', '\t']) {
    withConfigPath(t, value);
    assert.equal(defaultConfigPath(), path.join(root, 'config/config.yaml'), JSON.stringify(value));
  }
});

test('an absolute CONFIG_PATH is used as is', (t) => {
  const file = path.join(path.sep, 'srv', 'sdg', 'custom.yaml');
  withConfigPath(t, file);
  assert.equal(defaultConfigPath(), file);
});

test('a relative CONFIG_PATH resolves against the project root, not the working directory', (t) => {
  // The value shipped in .env.example
  withConfigPath(t, './config/config.yaml');
  const cwd = process.cwd();
  t.after(() => process.chdir(cwd));
  process.chdir(path.parse(root).root);

  assert.equal(defaultConfigPath(), path.join(root, 'config/config.yaml'));

  withConfigPath(t, 'alt/custom.yaml');
  assert.equal(defaultConfigPath(), path.join(root, 'alt/custom.yaml'));
});

test('whitespace around CONFIG_PATH is ignored', (t) => {
  withConfigPath(t, '  alt/custom.yaml \n');
  assert.equal(defaultConfigPath(), path.join(root, 'alt/custom.yaml'));
});
