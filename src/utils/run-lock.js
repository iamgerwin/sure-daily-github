import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from './logger.js';

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

// The raw SDG_RUN_LOCK_STALE_MS when it is set but not a positive number of
// milliseconds (`4h`, `-1`, `0`), else null. Such a value falls back to the
// 2-hour default, so a run raised past 2 hours on purpose (long test suites)
// can have its lock reclaimed by a concurrent run that then races it.
export function invalidRunLockStaleMs(raw = process.env.SDG_RUN_LOCK_STALE_MS) {
  const text = String(raw ?? '').trim();
  if (text === '') return null;
  const value = Number(text);
  return Number.isFinite(value) && value > 0 ? null : raw;
}

// Last invalid value reported, so a long-running scheduler that acquires the
// lock every tick warns once per value instead of on every run
let warnedStaleValue = null;

function warnInvalidStaleMs() {
  const invalid = invalidRunLockStaleMs();
  if (invalid === null || invalid === warnedStaleValue) return;
  warnedStaleValue = invalid;
  logger.warn('Ignoring SDG_RUN_LOCK_STALE_MS (expected a positive number of milliseconds); a lock older than the 2-hour default is reclaimed', { value: invalid });
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

function readRaw(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (_) {
    return null;
  }
}

function parseLock(raw) {
  try {
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function readLock(filePath) {
  return parseLock(readRaw(filePath));
}

// The age fallback covers a reused PID, so it must not depend on startedAt
// being sane: a missing or non-numeric value has no age (stale), and a value
// further ahead than the limit (the clock was stepped back, e.g. a reboot
// before NTP sync) is measured as distance, otherwise the lock would block
// every run until the clock caught up with it
function isStale(holder, now) {
  if (!holder || !Number.isInteger(holder.pid)) return true;
  if (!isProcessAlive(holder.pid)) return true;
  if (!Number.isFinite(holder.startedAt)) return true;
  return Math.abs(now - holder.startedAt) > staleMs();
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

// Two callers can judge the same lock stale; if the slower one simply deleted
// the lock path it would delete the lock the faster one had just created, and
// both would run. Renaming is atomic, so exactly one caller moves the lock aside,
// and a caller that moved a lock other than the stale one it read (a fresh lock
// taken meanwhile) puts it back before giving up.
function reclaimStaleLock(filePath, staleRaw) {
  const moved = `${filePath}.${process.pid}.${Date.now()}.stale`;
  try {
    fs.renameSync(filePath, moved);
  } catch (error) {
    // Already reclaimed by someone else
    if (error.code === 'ENOENT') return;
    throw error;
  }
  try {
    const raw = readRaw(moved);
    if (raw !== null && raw !== staleRaw) {
      try {
        createLockFile(filePath, raw);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }
  } finally {
    fs.rmSync(moved, { force: true });
  }
}

// Acquires an exclusive cross-process lock so concurrent executions (e.g. the
// scheduler service plus a manual `run`) cannot race on the state files.
// Returns { acquired: true, release } or { acquired: false, holder }.
// `filePath` selects a separate lock (pr-maint ticks must not wait on `run`).
export function acquireRunLock({ now = Date.now(), filePath = lockFilePath() } = {}) {
  warnInvalidStaleMs();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      createLockFile(filePath, JSON.stringify({ pid: process.pid, startedAt: now }));
      return { acquired: true, release: () => releaseRunLock(filePath) };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }

    const raw = readRaw(filePath);
    const holder = parseLock(raw);
    if (attempt > 0 || !isStale(holder, now)) {
      return { acquired: false, holder };
    }
    reclaimStaleLock(filePath, raw);
  }
}

function releaseRunLock(filePath) {
  // Only remove the lock if it is still ours (it may have been reclaimed as stale)
  const holder = readLock(filePath);
  if (holder?.pid === process.pid) {
    fs.rmSync(filePath, { force: true });
  }
}
