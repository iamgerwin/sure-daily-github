import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts/verify-status.sh');

// Installs the script into a throwaway app tree so it resolves paths from there
function makeAppDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-verify-'));
  for (const sub of ['scripts', 'logs', 'config', 'data']) fs.mkdirSync(path.join(dir, sub));
  fs.copyFileSync(script, path.join(dir, 'scripts/verify-status.sh'));
  return dir;
}

function run(appDir, env = {}, cwd = undefined) {
  const baseEnv = { ...process.env };
  delete baseEnv.CONFIG_PATH;
  delete baseEnv.SDG_ISSUE_STATE_FILE;
  delete baseEnv.SDG_HEARTBEAT_FILE;
  return execFileSync('bash', [path.join(appDir, 'scripts/verify-status.sh')], {
    encoding: 'utf8',
    cwd,
    // systemctl and pgrep complaints on hosts without systemd are not under test
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...baseEnv, ...env }
  });
}

function touch(file, contents, mtimeSeconds) {
  fs.writeFileSync(file, contents);
  fs.utimesSync(file, mtimeSeconds, mtimeSeconds);
}

test('verify-status reads the app tree it is installed in and skips health-check.log', (t) => {
  const appDir = makeAppDir();
  t.after(() => fs.rmSync(appDir, { recursive: true, force: true }));

  touch(path.join(appDir, 'logs/2026-10-31.log'), 'older daily entry\n', 1000);
  touch(path.join(appDir, 'logs/2026-11-01.log'), 'Scheduled task triggered\n', 2000);
  // Written by every health check, so it is always the newest file in logs/
  touch(path.join(appDir, 'logs/health-check.log'), 'Service is running\n', 3000);
  fs.writeFileSync(path.join(appDir, 'config/config.yaml'), [
    'general:',
    '  # timezone: "Europe/Berlin"',
    '  timezone: "Asia/Manila"',
    'schedule:',
    '  # cron: "0 0 * * *"',
    '  cron: "*/15 * * * *"',
    ''
  ].join('\n'));
  fs.writeFileSync(path.join(appDir, 'data/issue-state.json'),
    JSON.stringify({ lastDailyReset: '2026-11-01T00:00:01.000Z', repositories: {} }, null, 2));

  const output = run(appDir);

  assert.match(output, /Latest log: 2026-11-01\.log/);
  assert.match(output, /Scheduled task triggered/);
  assert.doesNotMatch(output, /health-check\.log/);
  assert.match(output, /cron: "\*\/15 \* \* \* \*"/);
  assert.doesNotMatch(output, /cron: "0 0 \* \* \*"/);
  assert.match(output, /timezone: "Asia\/Manila"/);
  assert.match(output, /Last reset: 2026-11-01T00:00:01\.000Z/);
});

test('verify-status honors CONFIG_PATH and SDG_ISSUE_STATE_FILE', (t) => {
  const appDir = makeAppDir();
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-verify-ext-'));
  t.after(() => {
    fs.rmSync(appDir, { recursive: true, force: true });
    fs.rmSync(elsewhere, { recursive: true, force: true });
  });

  const configFile = path.join(elsewhere, 'custom.yaml');
  const stateFile = path.join(elsewhere, 'state.json');
  fs.writeFileSync(configFile, 'schedule:\n  cron: "5 4 * * *"\n');
  fs.writeFileSync(stateFile, JSON.stringify({ lastDailyReset: '2026-10-30T16:00:00.000Z' }, null, 2));

  const output = run(appDir, { CONFIG_PATH: configFile, SDG_ISSUE_STATE_FILE: stateFile });

  assert.match(output, /cron: "5 4 \* \* \*"/);
  assert.match(output, /Last reset: 2026-10-30T16:00:00\.000Z/);
});

test('verify-status names the paths it looked at when files are missing', (t) => {
  const appDir = makeAppDir();
  t.after(() => fs.rmSync(appDir, { recursive: true, force: true }));
  // Only the health-check log exists: there is no app activity to show
  touch(path.join(appDir, 'logs/health-check.log'), 'Service is running\n', 3000);

  const output = run(appDir);

  assert.match(output, new RegExp(`No logs found in ${appDir}/logs`));
  assert.match(output, new RegExp(`Config file not found: ${appDir}/config/config\\.yaml`));
  assert.match(output, new RegExp(`State file not found: ${appDir}/data/issue-state\\.json`));
  assert.match(output, new RegExp(`No scheduler heartbeat at ${appDir}/data/scheduler-heartbeat\\.json`));
});

test('verify-status shows the last scheduler tick and the heartbeat age', (t) => {
  const appDir = makeAppDir();
  t.after(() => fs.rmSync(appDir, { recursive: true, force: true }));

  // Written by the scheduler as one line of JSON; 45 minutes old
  const mtime = Math.floor(Date.now() / 1000) - 45 * 60;
  touch(path.join(appDir, 'data/scheduler-heartbeat.json'),
    JSON.stringify({ lastTickAt: '2026-11-04T01:30:00.000Z', pid: 4242 }), mtime);

  const output = run(appDir);

  assert.match(output, /Last tick: 2026-11-04T01:30:00\.000Z \(4[56] minutes ago\)/);
  assert.doesNotMatch(output, /No scheduler heartbeat/);
});

test('verify-status honors SDG_HEARTBEAT_FILE', (t) => {
  const appDir = makeAppDir();
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-verify-hb-'));
  t.after(() => {
    fs.rmSync(appDir, { recursive: true, force: true });
    fs.rmSync(elsewhere, { recursive: true, force: true });
  });

  const heartbeatFile = path.join(elsewhere, 'heartbeat.json');
  fs.writeFileSync(heartbeatFile, JSON.stringify({ lastTickAt: '2026-11-04T02:00:00.000Z', pid: 1 }));

  const output = run(appDir, { SDG_HEARTBEAT_FILE: heartbeatFile });

  assert.match(output, /Last tick: 2026-11-04T02:00:00\.000Z \(0 minutes ago\)/);
});

test('verify-status resolves a relative SDG_HEARTBEAT_FILE against the app tree', (t) => {
  const appDir = makeAppDir();
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-verify-cwd-'));
  t.after(() => {
    fs.rmSync(appDir, { recursive: true, force: true });
    fs.rmSync(elsewhere, { recursive: true, force: true });
  });

  fs.mkdirSync(path.join(appDir, 'run'));
  fs.writeFileSync(path.join(appDir, 'run/heartbeat.json'), JSON.stringify({ lastTickAt: '2026-11-04T02:00:00.000Z', pid: 1 }));

  const output = run(appDir, { SDG_HEARTBEAT_FILE: 'run/heartbeat.json' }, elsewhere);

  assert.match(output, /Last tick: 2026-11-04T02:00:00\.000Z/);
  assert.doesNotMatch(output, /No scheduler heartbeat/);
});

test('verify-status reads SDG_HEARTBEAT_FILE from the app .env when the environment does not set it', (t) => {
  const appDir = makeAppDir();
  t.after(() => fs.rmSync(appDir, { recursive: true, force: true }));

  fs.mkdirSync(path.join(appDir, 'run'));
  fs.writeFileSync(path.join(appDir, 'run/tick.json'), JSON.stringify({ lastTickAt: '2026-11-04T02:00:00.000Z', pid: 1 }));
  fs.writeFileSync(path.join(appDir, '.env'), "GITHUB_TOKEN=ghp_x\nexport SDG_HEARTBEAT_FILE='run/tick.json'\n");

  const output = run(appDir);

  assert.match(output, /Last tick: 2026-11-04T02:00:00\.000Z/);
  assert.doesNotMatch(output, /No scheduler heartbeat/);
});

test('verify-status prefers SDG_HEARTBEAT_FILE from the environment over .env', (t) => {
  const appDir = makeAppDir();
  t.after(() => fs.rmSync(appDir, { recursive: true, force: true }));

  fs.writeFileSync(path.join(appDir, 'data/scheduler-heartbeat.json'), JSON.stringify({ lastTickAt: '2026-11-04T02:00:00.000Z', pid: 1 }));
  fs.writeFileSync(path.join(appDir, '.env'), 'SDG_HEARTBEAT_FILE=run/missing.json\n');

  const output = run(appDir, { SDG_HEARTBEAT_FILE: 'data/scheduler-heartbeat.json' });

  assert.match(output, /Last tick: 2026-11-04T02:00:00\.000Z/);
});

test('verify-status drops whitespace around a relative SDG_HEARTBEAT_FILE, as the scheduler does', (t) => {
  const appDir = makeAppDir();
  t.after(() => fs.rmSync(appDir, { recursive: true, force: true }));

  fs.mkdirSync(path.join(appDir, 'run'));
  fs.writeFileSync(path.join(appDir, 'run/heartbeat.json'), JSON.stringify({ lastTickAt: '2026-11-04T02:00:00.000Z', pid: 1 }));

  const output = run(appDir, { SDG_HEARTBEAT_FILE: ' run/heartbeat.json ' });

  assert.match(output, /Last tick: 2026-11-04T02:00:00\.000Z/);
  assert.doesNotMatch(output, /No scheduler heartbeat/);
});

test('verify-status keeps the default heartbeat for a blank SDG_HEARTBEAT_FILE, as the scheduler does', (t) => {
  const appDir = makeAppDir();
  t.after(() => fs.rmSync(appDir, { recursive: true, force: true }));

  fs.writeFileSync(path.join(appDir, 'data/scheduler-heartbeat.json'), JSON.stringify({ lastTickAt: '2026-11-04T02:00:00.000Z', pid: 1 }));

  const output = run(appDir, { SDG_HEARTBEAT_FILE: '   ' });

  assert.match(output, /Last tick: 2026-11-04T02:00:00\.000Z/);
  assert.doesNotMatch(output, /No scheduler heartbeat/);
});
