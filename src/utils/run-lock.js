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

// Filesystems without hard links; fall back to a plain exclusive create there
const NO_LINK_CODES = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV']);

// Publishes the lock fully written: the contents go to a private temp file that
// is then hard-linked into place, which fails with EEXIST if the lock exists.
// A plain open('wx') + write leaves an empty lock visible for a moment, and a
// concurrent caller would read it as unparseable, treat it as stale and take it.
function createLockFile(filePath, contents) {
  const tmpFile = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpFile, contents, { flag: 'wx' });
  try {
    fs.linkSync(tmpFile, filePath);
  } catch (error) {
    if (!NO_LINK_CODES.has(error.code)) throw error;
    fs.writeFileSync(filePath, contents, { flag: 'wx' });
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
}

// Acquires an exclusive cross-process lock so concurrent executions (e.g. the
// scheduler service plus a manual `run`) cannot race on the state files.
// Returns { acquired: true, release } or { acquired: false, holder }.
// `filePath` selects a separate lock (pr-maint ticks must not wait on `run`).
export function acquireRunLock({ now = Date.now(), filePath = lockFilePath() } = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      createLockFile(filePath, JSON.stringify({ pid: process.pid, startedAt: now }));
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
