import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { acquireRunLock } from '../src/utils/run-lock.js';
import executor from '../src/core/executor.js';

function useTmpLockFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-lock-'));
  const filePath = path.join(dir, 'nested', 'run.lock');
  process.env.SDG_RUN_LOCK_FILE = filePath;
  t.after(() => {
    delete process.env.SDG_RUN_LOCK_FILE;
    delete process.env.SDG_RUN_LOCK_STALE_MS;
  });
  return filePath;
}

// The parent process (the test runner) is guaranteed to be alive
function writeForeignLock(filePath, { pid = process.ppid, startedAt = Date.now() } = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ pid, startedAt }));
}

test('acquireRunLock is exclusive until released', (t) => {
  const filePath = useTmpLockFile(t);

  const first = acquireRunLock();
  assert.equal(first.acquired, true);
  assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf8')).pid, process.pid);

  const second = acquireRunLock();
  assert.equal(second.acquired, false);
  assert.equal(second.holder.pid, process.pid);

  first.release();
  assert.equal(fs.existsSync(filePath), false);

  const third = acquireRunLock();
  assert.equal(third.acquired, true);
  third.release();
});

test('acquireRunLock refuses a lock held by another live process', (t) => {
  const filePath = useTmpLockFile(t);
  writeForeignLock(filePath);

  const result = acquireRunLock();
  assert.equal(result.acquired, false);
  assert.equal(result.holder.pid, process.ppid);
});

test('acquireRunLock reclaims a lock left by a dead process', (t) => {
  const filePath = useTmpLockFile(t);
  // PIDs are capped well below this on Linux and macOS
  writeForeignLock(filePath, { pid: 2 ** 30 });

  const result = acquireRunLock();
  assert.equal(result.acquired, true);
  result.release();
});

test('acquireRunLock reclaims unreadable or expired locks', (t) => {
  const filePath = useTmpLockFile(t);

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '{not json');
  let result = acquireRunLock();
  assert.equal(result.acquired, true);
  result.release();

  process.env.SDG_RUN_LOCK_STALE_MS = '1000';
  writeForeignLock(filePath, { startedAt: Date.now() - 5000 });
  result = acquireRunLock();
  assert.equal(result.acquired, true);
  result.release();
});

test('release does not remove a lock that now belongs to someone else', (t) => {
  const filePath = useTmpLockFile(t);

  const lock = acquireRunLock();
  writeForeignLock(filePath);
  lock.release();
  assert.equal(fs.existsSync(filePath), true);
});

test('executor.execute skips when another process holds the lock', async (t) => {
  const filePath = useTmpLockFile(t);
  writeForeignLock(filePath);

  const original = executor.run;
  let calls = 0;
  executor.run = async () => { calls++; return { success: true }; };
  t.after(() => { executor.run = original; });

  const result = await executor.execute({});
  assert.equal(result.success, false);
  assert.equal(result.locked, true);
  assert.match(result.error, new RegExp(`pid ${process.ppid}`));
  assert.equal(calls, 0);
  assert.equal(fs.existsSync(filePath), true, 'foreign lock must be left in place');
});

test('executor.execute releases the lock even when the run throws', async (t) => {
  const filePath = useTmpLockFile(t);

  const original = executor.run;
  executor.run = async () => {
    assert.equal(fs.existsSync(filePath), true, 'lock is held during the run');
    throw new Error('boom');
  };
  t.after(() => { executor.run = original; });

  await assert.rejects(executor.execute({}), /boom/);
  assert.equal(fs.existsSync(filePath), false);
});
