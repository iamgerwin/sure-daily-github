import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadEnv, APP_ENV_FILE } from '../src/config/env.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-env-'));
  const cwd = path.join(dir, 'cwd');
  const app = path.join(dir, 'app');
  fs.mkdirSync(cwd);
  fs.mkdirSync(app);
  return { dir, cwd, appEnvFile: path.join(app, '.env') };
}

test('APP_ENV_FILE is the .env in the install directory', () => {
  assert.equal(APP_ENV_FILE, path.join(root, '.env'));
});

test('loads the install directory .env when the working directory has none', (t) => {
  const { dir, cwd, appEnvFile } = setup();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(appEnvFile, 'GITHUB_TOKEN=ghp_from_app\n');

  const env = {};
  loadEnv({ cwd, appEnvFile, processEnv: env });

  assert.equal(env.GITHUB_TOKEN, 'ghp_from_app');
});

test('the working directory .env wins and the install directory .env fills the gaps', (t) => {
  const { dir, cwd, appEnvFile } = setup();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, '.env'), 'GITHUB_TOKEN=ghp_from_cwd\n');
  fs.writeFileSync(appEnvFile, 'GITHUB_TOKEN=ghp_from_app\nLOG_LEVEL=debug\n');

  const env = {};
  loadEnv({ cwd, appEnvFile, processEnv: env });

  assert.equal(env.GITHUB_TOKEN, 'ghp_from_cwd');
  assert.equal(env.LOG_LEVEL, 'debug');
});

test('variables already in the environment are never overridden', (t) => {
  const { dir, cwd, appEnvFile } = setup();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, '.env'), 'GITHUB_TOKEN=ghp_from_cwd\n');
  fs.writeFileSync(appEnvFile, 'GITHUB_TOKEN=ghp_from_app\n');

  const env = { GITHUB_TOKEN: 'ghp_from_service' };
  loadEnv({ cwd, appEnvFile, processEnv: env });

  assert.equal(env.GITHUB_TOKEN, 'ghp_from_service');
});

test('reads one file once when the working directory is the install directory', (t) => {
  const { dir, appEnvFile } = setup();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(appEnvFile, 'GITHUB_TOKEN=ghp_from_app\n');

  const env = {};
  const files = loadEnv({ cwd: path.dirname(appEnvFile), appEnvFile, processEnv: env });

  assert.deepEqual(files, [appEnvFile]);
  assert.equal(env.GITHUB_TOKEN, 'ghp_from_app');
});

test('a missing .env in both places loads nothing and does not throw', (t) => {
  const { dir, cwd, appEnvFile } = setup();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const env = {};
  assert.doesNotThrow(() => loadEnv({ cwd, appEnvFile, processEnv: env }));
  assert.deepEqual(env, {});
});
