import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import scheduler from '../src/core/scheduler.js';
import executor from '../src/core/executor.js';
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
