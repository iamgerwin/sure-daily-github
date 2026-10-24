import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));

function runCli(args, { cwd, env = {} }) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    env: { ...process.env, LOG_LEVEL: 'error', GITHUB_TOKEN: 'ghp_test', ...env },
    encoding: 'utf8'
  });
}

test('init writes to CONFIG_PATH, not config/ under the working directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-cli-init-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-cli-init-cwd-'));
  const configFile = path.join(dir, 'nested', 'config.yaml');

  const result = runCli(['init'], { cwd, env: { CONFIG_PATH: configFile } });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.existsSync(configFile));
  assert.equal(fs.existsSync(path.join(cwd, 'config')), false);

  // The other commands find it through the same path
  const validate = runCli(['validate'], { cwd, env: { CONFIG_PATH: configFile } });
  assert.equal(validate.status, 0, validate.stderr);
  assert.match(validate.stdout, /Configuration is valid/);
});

test('init --config writes there and refuses to overwrite an existing file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-cli-init-'));
  const configFile = path.join(dir, 'custom.yaml');

  const first = runCli(['init', '--config', configFile], { cwd: dir });
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, new RegExp(`run --dry-run --config ${configFile}`));

  fs.writeFileSync(configFile, 'keep: me\n');
  const second = runCli(['init', '--config', configFile], { cwd: dir });
  assert.equal(second.status, 1);
  assert.equal(fs.readFileSync(configFile, 'utf8'), 'keep: me\n');
});

test('init template uses the contentTemplate keys the handlers read', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-cli-init-'));
  const configFile = path.join(dir, 'config.yaml');
  execFileSync(process.execPath, [cliPath, 'init', '--config', configFile], {
    env: { ...process.env, LOG_LEVEL: 'error' },
    encoding: 'utf8'
  });

  const written = yaml.load(fs.readFileSync(configFile, 'utf8'));
  assert.equal(written.contentTemplate.message, undefined);
  assert.equal(typeof written.contentTemplate.title, 'string');
  assert.match(written.contentTemplate.body, /\$\{date\}/);
  assert.match(written.repositories[0].commitMessage, /\$\{date\}/);
});
