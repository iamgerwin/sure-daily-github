import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { writeHeartbeat, heartbeatFilePath, maxExecutionMs, invalidMaxExecutionMinutes } from '../src/utils/heartbeat.js';
import logger from '../src/utils/logger.js';
import scheduler from '../src/core/scheduler.js';
import executor from '../src/core/executor.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HEALTH_CHECK = path.join(root, 'scripts', 'health-check.sh');

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-heartbeat-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function useHeartbeatFile(t, file) {
  const previous = process.env.SDG_HEARTBEAT_FILE;
  process.env.SDG_HEARTBEAT_FILE = file;
  t.after(() => {
    if (previous === undefined) delete process.env.SDG_HEARTBEAT_FILE;
    else process.env.SDG_HEARTBEAT_FILE = previous;
  });
}

test('writeHeartbeat records the tick time and pid, creating the directory', (t) => {
  const file = path.join(tmpDir(t), 'nested', 'heartbeat.json');
  const now = new Date('2026-10-30T01:02:03.000Z');

  assert.equal(writeHeartbeat({ now, filePath: file }), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { lastTickAt: now.toISOString(), pid: process.pid });
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['heartbeat.json']);
});

test('writeHeartbeat reports a failure instead of throwing', (t) => {
  const dir = tmpDir(t);
  // A file where the parent directory should be
  fs.writeFileSync(path.join(dir, 'blocker'), '');
  assert.equal(writeHeartbeat({ filePath: path.join(dir, 'blocker', 'heartbeat.json') }), false);
});

test('heartbeatFilePath honors SDG_HEARTBEAT_FILE', (t) => {
  useHeartbeatFile(t, '/tmp/custom-heartbeat.json');
  assert.equal(heartbeatFilePath(), '/tmp/custom-heartbeat.json');
});

test('every scheduled tick writes a heartbeat, including one skipped for overlap', async (t) => {
  const file = path.join(tmpDir(t), 'heartbeat.json');
  useHeartbeatFile(t, file);
  const original = executor.execute;
  let release;
  executor.execute = () => new Promise(resolve => { release = () => resolve({ success: true }); });
  t.after(() => { executor.execute = original; });

  const first = scheduler.runScheduledTask({});
  assert.ok(fs.existsSync(file), 'the tick that runs writes a heartbeat');

  fs.rmSync(file);
  assert.deepEqual(await scheduler.runScheduledTask({}), { skipped: true });
  assert.ok(fs.existsSync(file), 'a skipped tick still proves the timer fires');

  release();
  await first;
});

function useMaxExecutionMinutes(t, value) {
  const previous = process.env.SDG_MAX_EXECUTION_MINUTES;
  process.env.SDG_MAX_EXECUTION_MINUTES = value;
  t.after(() => {
    if (previous === undefined) delete process.env.SDG_MAX_EXECUTION_MINUTES;
    else process.env.SDG_MAX_EXECUTION_MINUTES = previous;
  });
}

test('a skipped tick stops refreshing the heartbeat once the execution exceeds SDG_MAX_EXECUTION_MINUTES', async (t) => {
  const file = path.join(tmpDir(t), 'heartbeat.json');
  useHeartbeatFile(t, file);
  useMaxExecutionMinutes(t, '60');
  const original = executor.execute;
  let release;
  executor.execute = () => new Promise(resolve => { release = () => resolve({ success: true }); });
  t.after(() => { executor.execute = original; });

  const first = scheduler.runScheduledTask({});

  fs.rmSync(file);
  assert.deepEqual(await scheduler.runScheduledTask({}), { skipped: true });
  assert.ok(fs.existsSync(file), 'an execution within the limit keeps the heartbeat fresh');

  fs.rmSync(file);
  scheduler.executionStartedAt = Date.now() - 61 * 60 * 1000;
  assert.deepEqual(await scheduler.runScheduledTask({}), { skipped: true });
  assert.ok(!fs.existsSync(file), 'a hung execution must let the heartbeat go stale');

  release();
  await first;
});

test('maxExecutionMs is off unless SDG_MAX_EXECUTION_MINUTES is whole minutes', (t) => {
  useMaxExecutionMinutes(t, 'abc');
  assert.equal(maxExecutionMs(), 0);
  process.env.SDG_MAX_EXECUTION_MINUTES = '090';
  assert.equal(maxExecutionMs(), 90 * 60 * 1000);
});

test('maxExecutionMs ignores whitespace around SDG_MAX_EXECUTION_MINUTES', (t) => {
  useMaxExecutionMinutes(t, ' 45 ');
  assert.equal(maxExecutionMs(), 45 * 60 * 1000);
  process.env.SDG_MAX_EXECUTION_MINUTES = '30\n';
  assert.equal(maxExecutionMs(), 30 * 60 * 1000);
  assert.equal(invalidMaxExecutionMinutes(), null);
});

test('invalidMaxExecutionMinutes reports only a set value that is not whole minutes', (t) => {
  useMaxExecutionMinutes(t, '1h');
  assert.equal(invalidMaxExecutionMinutes(), '1h');
  process.env.SDG_MAX_EXECUTION_MINUTES = '-5';
  assert.equal(invalidMaxExecutionMinutes(), '-5');
  process.env.SDG_MAX_EXECUTION_MINUTES = '2.5';
  assert.equal(invalidMaxExecutionMinutes(), '2.5');
  for (const value of ['', '   ', '0', '90']) {
    process.env.SDG_MAX_EXECUTION_MINUTES = value;
    assert.equal(invalidMaxExecutionMinutes(), null, `"${value}" is valid or unset`);
  }
  delete process.env.SDG_MAX_EXECUTION_MINUTES;
  assert.equal(invalidMaxExecutionMinutes(), null);
});

function captureLogs(t) {
  const calls = [];
  for (const level of ['info', 'warn']) {
    const original = logger[level];
    logger[level] = (message, meta) => calls.push({ level, message, meta });
    t.after(() => { logger[level] = original; });
  }
  return calls;
}

test('start warns when SDG_MAX_EXECUTION_MINUTES is set but not whole minutes', (t) => {
  useHeartbeatFile(t, path.join(tmpDir(t), 'heartbeat.json'));
  useMaxExecutionMinutes(t, '2h');
  const calls = captureLogs(t);
  t.after(() => scheduler.stop());

  assert.equal(scheduler.start({ schedule: { enabled: true, cron: '0 0 1 1 *' }, general: {} }), true);
  const started = calls.find(c => c.message === 'Scheduler started');
  assert.equal(started.meta.maxExecutionMinutes, 'off');
  const warning = calls.find(c => c.level === 'warn' && /SDG_MAX_EXECUTION_MINUTES/.test(c.message));
  assert.ok(warning, 'an invalid limit is reported');
  assert.equal(warning.meta.value, '2h');
});

test('start logs the active execution limit without a warning', (t) => {
  useHeartbeatFile(t, path.join(tmpDir(t), 'heartbeat.json'));
  useMaxExecutionMinutes(t, '120');
  const calls = captureLogs(t);
  t.after(() => scheduler.stop());

  assert.equal(scheduler.start({ schedule: { enabled: true, cron: '0 0 1 1 *' }, general: {} }), true);
  assert.equal(calls.find(c => c.message === 'Scheduler started').meta.maxExecutionMinutes, 120);
  assert.equal(calls.filter(c => c.level === 'warn').length, 0);
});

test('start writes a heartbeat before the first tick', (t) => {
  const file = path.join(tmpDir(t), 'heartbeat.json');
  useHeartbeatFile(t, file);
  t.after(() => scheduler.stop());

  assert.equal(scheduler.start({ schedule: { enabled: true, cron: '0 0 1 1 *' }, general: {} }), true);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, process.pid);
});

// Runs scripts/health-check.sh against a stub systemctl that records every
// call and, unless `active` is false, reports the service as active.
// `heartbeat` is where the stale/fresh heartbeat is written, `dotenv` the
// app's .env contents and `env` extra variables for the script.
function runHealthCheck(t, { heartbeatAgeMinutes, maxAge, active = true, dir = tmpDir(t), heartbeat = path.join(dir, 'data', 'scheduler-heartbeat.json'), dotenv, env: extraEnv = {} }) {
  const bin = path.join(dir, 'bin');
  const calls = path.join(dir, 'systemctl-calls');
  fs.mkdirSync(bin, { recursive: true });
  const isActive = active ? 'exit 0' : 'exit 3';
  fs.writeFileSync(path.join(bin, 'systemctl'), `#!/bin/bash\necho "$*" >> "${calls}"\n[ "$1" = show ] && echo 4242\n[ "$1" = is-active ] && ${isActive}\nexit 0\n`, { mode: 0o755 });
  // sleep after a restart is not worth waiting for in a test
  fs.writeFileSync(path.join(bin, 'sleep'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });

  if (dotenv !== undefined) fs.writeFileSync(path.join(dir, '.env'), dotenv);
  if (heartbeatAgeMinutes !== undefined) {
    fs.mkdirSync(path.dirname(heartbeat), { recursive: true });
    fs.writeFileSync(heartbeat, '{}');
    const mtime = new Date(Date.now() - heartbeatAgeMinutes * 60 * 1000);
    fs.utimesSync(heartbeat, mtime, mtime);
  }

  const env = { PATH: `${bin}:${process.env.PATH}`, SDG_APP_DIR: dir, ...extraEnv };
  if (maxAge !== undefined) env.HEARTBEAT_MAX_AGE_MINUTES = String(maxAge);
  const { status } = spawnSync('bash', [HEALTH_CHECK], { env });

  return {
    status,
    calls: fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n') : [],
    log: fs.readFileSync(path.join(dir, 'logs', 'health-check.log'), 'utf8')
  };
}

test('health-check restarts a running service whose heartbeat is older than the limit', (t) => {
  const { calls, log } = runHealthCheck(t, { heartbeatAgeMinutes: 120, maxAge: 90 });
  assert.ok(calls.includes('restart sure-daily-github'), calls.join('\n'));
  assert.match(log, /heartbeat is 120 minutes old/);
});

test('health-check leaves a running service with a fresh heartbeat alone', (t) => {
  const { calls } = runHealthCheck(t, { heartbeatAgeMinutes: 10, maxAge: 90 });
  assert.ok(!calls.some(c => c.startsWith('restart')), calls.join('\n'));
});

test('health-check skips the hang check unless HEARTBEAT_MAX_AGE_MINUTES is set', (t) => {
  const { calls } = runHealthCheck(t, { heartbeatAgeMinutes: 600 });
  assert.ok(!calls.some(c => c.startsWith('restart')), calls.join('\n'));
});

test('health-check does not restart when no heartbeat has been written yet', (t) => {
  const { calls, log } = runHealthCheck(t, { maxAge: 90 });
  assert.ok(!calls.some(c => c.startsWith('restart')), calls.join('\n'));
  assert.match(log, /No scheduler heartbeat/);
});

// The service reads SDG_HEARTBEAT_FILE from .env through dotenv; cron runs the
// health check without it, so the script has to read the same file
test('health-check finds a heartbeat moved by SDG_HEARTBEAT_FILE in the app .env', (t) => {
  const dir = tmpDir(t);
  const heartbeat = path.join(dir, 'elsewhere', 'tick.json');
  const { calls, log } = runHealthCheck(t, {
    dir,
    heartbeat,
    heartbeatAgeMinutes: 120,
    maxAge: 90,
    dotenv: `GITHUB_TOKEN=ghp_x\n# SDG_HEARTBEAT_FILE=/nowhere.json\nexport SDG_HEARTBEAT_FILE="${heartbeat}"\n`
  });
  assert.ok(calls.includes('restart sure-daily-github'), calls.join('\n'));
  assert.match(log, /heartbeat is 120 minutes old/);
});

test('health-check reads an unquoted .env value without its comment or trailing spaces', (t) => {
  const dir = tmpDir(t);
  const heartbeat = path.join(dir, 'elsewhere', 'tick.json');
  const { calls } = runHealthCheck(t, {
    dir,
    heartbeat,
    heartbeatAgeMinutes: 120,
    maxAge: 90,
    dotenv: `SDG_HEARTBEAT_FILE = ${heartbeat}   # moved off the data volume\r\n`
  });
  assert.ok(calls.includes('restart sure-daily-github'), calls.join('\n'));
});

test('health-check resolves a relative SDG_HEARTBEAT_FILE against the app directory', (t) => {
  const dir = tmpDir(t);
  const { calls } = runHealthCheck(t, {
    dir,
    heartbeat: path.join(dir, 'run', 'tick.json'),
    heartbeatAgeMinutes: 120,
    maxAge: 90,
    dotenv: "SDG_HEARTBEAT_FILE='run/tick.json'\n"
  });
  assert.ok(calls.includes('restart sure-daily-github'), calls.join('\n'));
});

test('health-check prefers SDG_HEARTBEAT_FILE from the environment over .env', (t) => {
  const dir = tmpDir(t);
  const heartbeat = path.join(dir, 'from-env.json');
  const { calls, log } = runHealthCheck(t, {
    dir,
    heartbeat,
    heartbeatAgeMinutes: 10,
    maxAge: 90,
    dotenv: `SDG_HEARTBEAT_FILE=${path.join(dir, 'missing.json')}\n`,
    env: { SDG_HEARTBEAT_FILE: heartbeat }
  });
  assert.ok(!calls.some(c => c.startsWith('restart')), calls.join('\n'));
  assert.doesNotMatch(log, /No scheduler heartbeat/);
});

test('health-check keeps the default heartbeat when .env does not set one', (t) => {
  const { calls } = runHealthCheck(t, { heartbeatAgeMinutes: 120, maxAge: 90, dotenv: 'LOG_LEVEL=info\n' });
  assert.ok(calls.includes('restart sure-daily-github'), calls.join('\n'));
});

test('health-check reads a limit with a leading zero as decimal', (t) => {
  const { calls, log, status } = runHealthCheck(t, { heartbeatAgeMinutes: 120, maxAge: '090' });
  assert.equal(status, 0);
  assert.ok(calls.includes('restart sure-daily-github'), calls.join('\n'));
  assert.match(log, /\(limit 90,/);
});

test('health-check does not restart again when the last hang restart left the heartbeat stale', (t) => {
  const dir = tmpDir(t);
  const first = runHealthCheck(t, { dir, heartbeatAgeMinutes: 120, maxAge: 90 });
  assert.ok(first.calls.includes('restart sure-daily-github'), first.calls.join('\n'));

  // The restarted service never rewrote the heartbeat (e.g. it cannot write it)
  fs.rmSync(path.join(dir, 'systemctl-calls'));
  const second = runHealthCheck(t, { dir, heartbeatAgeMinutes: 150, maxAge: 90 });
  assert.equal(second.status, 0);
  assert.ok(!second.calls.some(c => c.startsWith('restart')), second.calls.join('\n'));
  assert.match(second.log, /was not refreshed after the hang restart.*Not restarting again/);
});

test('health-check restarts a hang again once the heartbeat was refreshed after the last restart', (t) => {
  const dir = tmpDir(t);
  runHealthCheck(t, { dir, heartbeatAgeMinutes: 120, maxAge: 90 });
  // The previous restart was followed by a fresh heartbeat, which then went stale again
  const marker = path.join(dir, 'logs', 'health-check-hang-restart');
  const old = new Date(Date.now() - 300 * 60 * 1000);
  fs.utimesSync(marker, old, old);

  fs.rmSync(path.join(dir, 'systemctl-calls'));
  const { calls } = runHealthCheck(t, { dir, heartbeatAgeMinutes: 120, maxAge: 90 });
  assert.ok(calls.includes('restart sure-daily-github'), calls.join('\n'));
});

test('health-check ignores a non-numeric limit and exits cleanly', (t) => {
  const { calls, log, status } = runHealthCheck(t, { heartbeatAgeMinutes: 600, maxAge: 'abc' });
  assert.equal(status, 0);
  assert.ok(!calls.some(c => c.startsWith('restart')), calls.join('\n'));
  assert.match(log, /Ignoring HEARTBEAT_MAX_AGE_MINUTES=abc/);
});

test('health-check exits 1 when the service does not come back after a restart', (t) => {
  const { calls, log, status } = runHealthCheck(t, { active: false });
  assert.equal(status, 1);
  assert.ok(calls.includes('restart sure-daily-github'), calls.join('\n'));
  assert.match(log, /Failed to restart service/);
});

test('a tick still runs the execution when the heartbeat cannot be written', async (t) => {
  const dir = tmpDir(t);
  // A file where the heartbeat's directory should be
  fs.writeFileSync(path.join(dir, 'blocker'), '');
  useHeartbeatFile(t, path.join(dir, 'blocker', 'heartbeat.json'));
  const original = executor.execute;
  let executed = false;
  executor.execute = async () => { executed = true; return { success: true }; };
  t.after(() => { executor.execute = original; });

  assert.deepEqual(await scheduler.runScheduledTask({}), { success: true });
  assert.ok(executed);
});
