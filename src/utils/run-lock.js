import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Anchored to the project root so the service and a manual `cli.js run` share it
const DEFAULT_LOCK_FILE = path.join(__dirname, '../../data/run.lock');
// Fallback for PID reuse: a lock older than this is reclaimed even if its PID is alive
const DEFAULT_STALE_MS = 2 * 60 * 60 * 1000;

function lockFilePath() {
  return process.env.SDG_RUN_LOCK_FILE || DEFAULT_LOCK_FILE;
}

function staleMs() {
  const value = Number(process.env.SDG_RUN_LOCK_STALE_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_STALE_MS;
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user
    return error.code === 'EPERM';
  }
}

function readLock(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function isStale(holder, now) {
  if (!holder || !Number.isInteger(holder.pid)) return true;
  if (!isProcessAlive(holder.pid)) return true;
  return now - (holder.startedAt || 0) > staleMs();
}

// Acquires an exclusive cross-process lock so concurrent executions (e.g. the
// scheduler service plus a manual `run`) cannot race on the state files.
// Returns { acquired: true, release } or { acquired: false, holder }.
export function acquireRunLock({ now = Date.now() } = {}) {
  const filePath = lockFilePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(filePath, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: now }));
      fs.closeSync(fd);
      return { acquired: true, release: () => releaseRunLock(filePath) };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }

    const holder = readLock(filePath);
    if (attempt > 0 || !isStale(holder, now)) {
      return { acquired: false, holder };
    }
    fs.rmSync(filePath, { force: true });
  }
}

function releaseRunLock(filePath) {
  // Only remove the lock if it is still ours (it may have been reclaimed as stale)
  const holder = readLock(filePath);
  if (holder?.pid === process.pid) {
    fs.rmSync(filePath, { force: true });
  }
}
