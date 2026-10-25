import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import scheduler from '../src/core/scheduler.js';
import executor from '../src/core/executor.js';
import babysitter from '../src/core/babysitter.js';
import { createOctokit } from '../src/github/octokit.js';

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
