import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import scheduler from '../src/core/scheduler.js';
import executor from '../src/core/executor.js';
import babysitter from '../src/core/babysitter.js';
import cron from 'node-cron';
import { createOctokit } from '../src/github/octokit.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Ticks write a heartbeat; keep it out of the project's data/ directory
const heartbeatDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-scheduler-'));
process.env.SDG_HEARTBEAT_FILE = path.join(heartbeatDir, 'heartbeat.json');
test.after(() => fs.rmSync(heartbeatDir, { recursive: true, force: true }));

test('runScheduledTask skips a tick while the previous execution is in flight', async () => {
  const original = executor.execute;
  let calls = 0;
  let release;
  executor.execute = () => {
    calls++;
    return new Promise(resolve => { release = () => resolve({ success: true }); });
  };

  try {
    const first = scheduler.runScheduledTask({});
    const second = await scheduler.runScheduledTask({});
    assert.deepEqual(second, { skipped: true });
    assert.equal(calls, 1);

    release();
    assert.deepEqual(await first, { success: true });

    // Guard is released once the execution finishes
    const third = scheduler.runScheduledTask({});
    release();
    await third;
    assert.equal(calls, 2);
  } finally {
    executor.execute = original;
  }
});

test('runScheduledTask releases the guard when execution throws', async () => {
  const original = executor.execute;
  executor.execute = async () => { throw new Error('boom'); };

  try {
    const result = await scheduler.runScheduledTask({});
    assert.deepEqual(result, { success: false, error: 'boom' });
    assert.equal(scheduler.executing, false);
  } finally {
    executor.execute = original;
  }
});

test('runScheduledTask runs a babysit scan after the execution only when babysit is enabled', async (t) => {
  const originalExecute = executor.execute;
  const originalBabysit = babysitter.execute;
  const order = [];
  executor.execute = async () => { order.push('execute'); return { success: true }; };
  babysitter.execute = async () => { order.push('babysit'); return { success: true, summary: { failed: 0 } }; };
  t.after(() => {
    executor.execute = originalExecute;
    babysitter.execute = originalBabysit;
  });

  assert.deepEqual(await scheduler.runScheduledTask({}), { success: true });
  assert.deepEqual(await scheduler.runScheduledTask({ babysit: { enabled: false } }), { success: true });
  assert.deepEqual(order, ['execute', 'execute']);

  assert.deepEqual(await scheduler.runScheduledTask({ babysit: { enabled: true } }), { success: true });
  assert.deepEqual(order, ['execute', 'execute', 'execute', 'babysit']);
});

test('a failing babysit scan does not change the scheduled execution result', async (t) => {
  const originalExecute = executor.execute;
  const originalBabysit = babysitter.execute;
  executor.execute = async () => ({ success: true });
  babysitter.execute = async () => { throw new Error('engine exploded'); };
  t.after(() => {
    executor.execute = originalExecute;
    babysitter.execute = originalBabysit;
  });

  assert.deepEqual(await scheduler.runScheduledTask({ babysit: { enabled: true } }), { success: true });
  assert.equal(scheduler.executing, false);
});

test('GitHub requests are aborted after GITHUB_REQUEST_TIMEOUT_MS', async () => {
  // Server accepts connections but never responds
  const server = http.createServer(() => {});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  process.env.GITHUB_REQUEST_TIMEOUT_MS = '200';
  try {
    const octokit = createOctokit({ baseUrl: `http://127.0.0.1:${port}`, retry: { retries: 0 } });
    const started = Date.now();
    await assert.rejects(octokit.request('GET /user'));
    assert.ok(Date.now() - started < 5000, 'request should be aborted quickly');
  } finally {
    delete process.env.GITHUB_REQUEST_TIMEOUT_MS;
    server.closeAllConnections();
    server.close();
  }
});

test('handleShutdown stops the scheduler and exits when no babysit scan is running', (t) => {
  const originalRunning = babysitter.isRunning;
  babysitter.isRunning = () => false;
  t.after(() => { babysitter.isRunning = originalRunning; });

  let stopped = false;
  scheduler.task = { stop: () => { stopped = true; } };
  scheduler.running = true;
  const exits = [];

  assert.equal(scheduler.handleShutdown('SIGTERM', { exit: code => exits.push(code) }), true);
  assert.equal(stopped, true);
  assert.equal(scheduler.isRunning(), false);
  assert.deepEqual(exits, [0]);
});

test('handleShutdown leaves the exit to an in-flight babysit scan', (t) => {
  const originalRunning = babysitter.isRunning;
  babysitter.isRunning = () => true;
  t.after(() => { babysitter.isRunning = originalRunning; });

  scheduler.task = { stop: () => {} };
  scheduler.running = true;
  const exits = [];

  assert.equal(scheduler.handleShutdown('SIGINT', { exit: code => exits.push(code) }), false);
  assert.equal(scheduler.isRunning(), false);
  assert.deepEqual(exits, []);

  // A repeated signal still defers to the babysit scan
  assert.equal(scheduler.handleShutdown('SIGINT', { exit: code => exits.push(code) }), false);
  assert.deepEqual(exits, []);
});

test('handleShutdown waits for an in-flight execution and exits once it finishes', async (t) => {
  const originalRunning = babysitter.isRunning;
  const originalExecute = executor.execute;
  const originalBabysit = babysitter.execute;
  babysitter.isRunning = () => false;
  let release;
  executor.execute = () => new Promise(resolve => { release = () => resolve({ success: true }); });
  let babysitCalls = 0;
  babysitter.execute = async () => { babysitCalls++; return { success: true }; };
  t.after(() => {
    babysitter.isRunning = originalRunning;
    executor.execute = originalExecute;
    babysitter.execute = originalBabysit;
  });

  scheduler.task = { stop: () => {} };
  scheduler.running = true;
  const exits = [];

  const tick = scheduler.runScheduledTask({ babysit: { enabled: true } });
  assert.equal(scheduler.handleShutdown('SIGTERM', { exit: code => exits.push(code) }), false);
  assert.equal(scheduler.isRunning(), false);
  assert.deepEqual(exits, []);

  release();
  assert.deepEqual(await tick, { success: true });
  assert.deepEqual(exits, [0]);
  // The babysit scan that would follow the execution is skipped on shutdown
  assert.equal(babysitCalls, 0);
  assert.equal(scheduler.pendingExit, null);
});

test('a second signal exits at once while an execution is still in flight', async (t) => {
  const originalRunning = babysitter.isRunning;
  const originalExecute = executor.execute;
  babysitter.isRunning = () => false;
  let release;
  executor.execute = () => new Promise(resolve => { release = () => resolve({ success: true }); });
  t.after(() => {
    babysitter.isRunning = originalRunning;
    executor.execute = originalExecute;
  });

  const exits = [];
  const tick = scheduler.runScheduledTask({});
  assert.equal(scheduler.handleShutdown('SIGINT', { exit: code => exits.push(code) }), false);
  assert.equal(scheduler.handleShutdown('SIGINT', { exit: code => exits.push(code) }), true);
  assert.deepEqual(exits, [0]);

  // The finished execution does not exit a second time
  release();
  await tick;
  assert.deepEqual(exits, [0]);
});

test('installSignalHandlers handles SIGINT and SIGTERM until removed', (t) => {
  const originalRunning = babysitter.isRunning;
  babysitter.isRunning = () => false;
  t.after(() => { babysitter.isRunning = originalRunning; });

  const exits = [];
  const before = { SIGINT: process.listenerCount('SIGINT'), SIGTERM: process.listenerCount('SIGTERM') };
  const remove = scheduler.installSignalHandlers({ exit: code => exits.push(code) });
  try {
    process.emit('SIGINT', 'SIGINT');
    process.emit('SIGTERM', 'SIGTERM');
    assert.deepEqual(exits, [0, 0]);
  } finally {
    remove();
  }
  assert.equal(process.listenerCount('SIGINT'), before.SIGINT);
  assert.equal(process.listenerCount('SIGTERM'), before.SIGTERM);
});

test('babysitter.isRunning reflects whether a scan holds the lock', () => {
  assert.equal(babysitter.isRunning(), false);
  babysitter.lock = { release() {} };
  try {
    assert.equal(babysitter.isRunning(), true);
  } finally {
    babysitter.lock = null;
  }
});

// Replaces node-cron's schedule() with a recorder, so start() can be checked
// without a real timer firing; the scheduler is stopped after the test
function stubCronSchedule(t) {
  const original = cron.schedule;
  const scheduled = [];
  cron.schedule = (expression, callback, options) => {
    const task = { stopped: false, stop() { this.stopped = true; } };
    scheduled.push({ expression, callback, options, task });
    return task;
  };
  t.after(() => {
    if (scheduler.isRunning()) scheduler.stop();
    cron.schedule = original;
  });
  return scheduled;
}

test('start schedules nothing when the schedule is disabled or missing', (t) => {
  const scheduled = stubCronSchedule(t);

  assert.equal(scheduler.start({ schedule: { enabled: false, cron: '0 9 * * *' }, general: {} }), false);
  assert.equal(scheduler.start({ general: {} }), false);
  assert.equal(scheduler.isRunning(), false);
  assert.equal(scheduled.length, 0);
});

test('start rejects an invalid cron expression and stays stopped', (t) => {
  const scheduled = stubCronSchedule(t);

  assert.throws(
    () => scheduler.start({ schedule: { enabled: true, cron: 'every morning' }, general: {} }),
    /Invalid cron expression: every morning/
  );
  assert.equal(scheduler.isRunning(), false);
  assert.equal(scheduler.task, null);
  assert.equal(scheduled.length, 0);
});

test('start refuses a second schedule while running and can start again after stop', (t) => {
  const scheduled = stubCronSchedule(t);
  const cfg = { schedule: { enabled: true, cron: '0 9 * * *' }, general: {} };

  assert.equal(scheduler.start(cfg), true);
  assert.equal(scheduler.isRunning(), true);
  assert.equal(scheduler.start(cfg), false);
  assert.equal(scheduled.length, 1, 'a second start must not add another cron task');

  assert.equal(scheduler.stop(), true);
  assert.equal(scheduled[0].task.stopped, true);
  assert.equal(scheduler.isRunning(), false);
  assert.equal(scheduler.task, null);
  assert.equal(scheduler.stop(), false, 'stopping twice is a no-op');

  assert.equal(scheduler.start(cfg), true);
  assert.equal(scheduled.length, 2);
});

test('start fires in schedule.timezone, then general.timezone, then UTC', (t) => {
  const scheduled = stubCronSchedule(t);
  const cases = [
    [{ timezone: 'Asia/Manila' }, { timezone: 'Europe/Berlin' }, 'Asia/Manila'],
    [{}, { timezone: 'Europe/Berlin' }, 'Europe/Berlin'],
    [{}, {}, 'UTC']
  ];

  for (const [schedule, general, expected] of cases) {
    assert.equal(scheduler.start({ schedule: { enabled: true, cron: '*/30 * * * *', ...schedule }, general }), true);
    scheduler.stop();
    assert.equal(scheduled.at(-1).options.timezone, expected);
    assert.equal(scheduled.at(-1).expression, '*/30 * * * *');
  }
});

test('each cron tick runs a scheduled execution with the started config', async (t) => {
  const scheduled = stubCronSchedule(t);
  const originalExecute = executor.execute;
  const seen = [];
  executor.execute = async (cfg) => { seen.push(cfg); return { success: true }; };
  t.after(() => { executor.execute = originalExecute; });
  const cfg = { schedule: { enabled: true, cron: '0 9 * * *' }, general: {} };

  assert.equal(scheduler.start(cfg), true);
  assert.deepEqual(await scheduled[0].callback(), { success: true });
  assert.equal(seen.length, 1);
  assert.equal(seen[0], cfg);
});

test('runScheduledTask returns a locked or failed execution result unchanged', async (t) => {
  const originalExecute = executor.execute;
  const originalBabysit = babysitter.execute;
  let babysitRuns = 0;
  babysitter.execute = async () => { babysitRuns++; return { success: true, summary: { failed: 0 } }; };
  t.after(() => {
    executor.execute = originalExecute;
    babysitter.execute = originalBabysit;
  });

  const locked = { success: false, locked: true, error: 'Run lock held by PID 1' };
  executor.execute = async () => locked;
  assert.equal(await scheduler.runScheduledTask({}), locked);

  const failed = { success: false, error: 'config gone' };
  executor.execute = async () => failed;
  assert.equal(await scheduler.runScheduledTask({ babysit: { enabled: true } }), failed);
  // The babysit scan is independent of the execution outcome
  assert.equal(babysitRuns, 1);
  assert.equal(scheduler.executing, false);
});
