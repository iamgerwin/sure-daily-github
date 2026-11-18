import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { clampTimerMs } from './process.js';
import logger from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Anchored to the project root so the service and a manual `cli.js run` share it
const DEFAULT_LOCK_FILE = path.join(__dirname, '../../data/run.lock');
// Fallback for PID reuse: a lock older than this is reclaimed even if its PID is alive
const DEFAULT_STALE_MS = 2 * 60 * 60 * 1000;
// A held lock is refreshed this often (at most), well inside the stale window
const MAX_REFRESH_MS = 10 * 60 * 1000;
const MIN_REFRESH_MS = 1000;

function lockFilePath() {
  return process.env.SDG_RUN_LOCK_FILE || DEFAULT_LOCK_FILE;
}

function staleMs() {
  const value = Number(process.env.SDG_RUN_LOCK_STALE_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_STALE_MS;
}

// Contents of each lock this process currently holds, by path. A lock naming
// our own PID that is not in here was written by an earlier process that got
// the same PID: in a container the service is PID 1 on every start, so after a
// crash or a killed stop its lock would otherwise look held by a live process
// until the age limit, skipping every run in between.
const heldLocks = new Map();

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

// How often a held lock rewrites its refreshedAt: a quarter of the stale
// window, so a live holder is never judged stale by its age
function refreshIntervalMs() {
  return clampTimerMs(Math.max(MIN_REFRESH_MS, Math.min(Math.floor(staleMs() / 4), MAX_REFRESH_MS)));
}

// The age fallback covers a reused PID, so it must not depend on startedAt
// being sane: a missing or non-numeric value has no age (stale), and a value
// further ahead than the limit (the clock was stepped back, e.g. a reboot
// before NTP sync) is measured as distance, otherwise the lock would block
// every run until the clock caught up with it. A live holder keeps
// refreshedAt current, so its age is measured from the last refresh: a babysit
// or fix-conflicts run longer than the window keeps its lock, while a lock
// whose PID was reused by an unrelated process stops being refreshed and ages out.
function isStale(holder, raw, filePath, now) {
  if (!holder || !Number.isInteger(holder.pid)) return true;
  if (holder.pid === process.pid) return heldLocks.get(filePath) !== raw;
  if (!isProcessAlive(holder.pid)) return true;
  if (!Number.isFinite(holder.startedAt)) return true;
  const lastSeen = Number.isFinite(holder.refreshedAt) ? holder.refreshedAt : holder.startedAt;
  return Math.abs(now - lastSeen) > staleMs();
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

// Rewrites refreshedAt on a lock this process still holds. Checking the file
// and then overwriting it would race a reclaim in between (the overwrite could
// replace a lock another process just took, leaving two holders), so like
// reclaimStaleLock it moves the lock aside atomically, checks that what it
// moved is still ours, and publishes the refreshed lock with an exclusive
// create: if anyone took the path meanwhile, theirs wins and ours is lost.
// A lock that is not ours is put back untouched. Never throws: it runs from a
// timer, and a failed refresh only shortens the lock's life.
// Returns 'refreshed', 'lost' (the lock is gone or someone else's) or 'failed'
// (a filesystem error left our lock as it was).
function refreshLock(filePath, held, now = Date.now()) {
  const moved = `${filePath}.${process.pid}.${Date.now()}.refresh`;
  try {
    fs.renameSync(filePath, moved);
  } catch (error) {
    return error.code === 'ENOENT' ? 'lost' : 'failed';
  }
  // Puts the moved file back unchanged, unless the path was taken meanwhile
  const putBack = () => {
    try {
      fs.linkSync(moved, filePath);
    } catch (error) {
      if (NO_LINK_CODES.has(error.code) && !fs.existsSync(filePath)) fs.renameSync(moved, filePath);
    }
  };
  try {
    const raw = readRaw(moved);
    if (raw === null) {
      // Unreadable (e.g. EACCES): we cannot tell whose it is, so keep it
      putBack();
      return 'failed';
    }
    if (raw !== held.raw) {
      putBack();
      return 'lost';
    }
    const contents = JSON.stringify({ pid: process.pid, startedAt: held.startedAt, refreshedAt: now });
    try {
      createLockFile(filePath, contents);
    } catch (error) {
      if (error.code === 'EEXIST') return 'lost';
      // Could not publish the refresh: restore the lock as it was
      putBack();
      return readRaw(filePath) === raw ? 'failed' : 'lost';
    }
    if (heldLocks.get(filePath) === held.raw) heldLocks.set(filePath, contents);
    held.raw = contents;
    return 'refreshed';
  } catch (_) {
    return 'failed';
  } finally {
    try { fs.rmSync(moved, { force: true }); } catch (_) {}
  }
}

// Acquires an exclusive cross-process lock so concurrent executions (e.g. the
// scheduler service plus a manual `run`) cannot race on the state files.
// Returns { acquired: true, release, refresh, lost } or { acquired: false, holder }.
// `lost` turns true (with a warning, and refreshing stops) once a refresh finds
// the lock removed or taken over, so a caller can decide whether to stop.
// While held, the lock is refreshed every `refreshMs` so a run longer than
// SDG_RUN_LOCK_STALE_MS is not mistaken for a reused PID; release stops it.
// `filePath` selects a separate lock (pr-maint ticks must not wait on `run`).
export function acquireRunLock({ now = Date.now(), filePath = lockFilePath(), refreshMs = refreshIntervalMs() } = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = JSON.stringify({ pid: process.pid, startedAt: now });
      createLockFile(filePath, raw);
      heldLocks.set(filePath, raw);
      const held = { raw, startedAt: now, lost: false };
      let timer = null;
      const refresh = (at) => {
        if (held.lost) return false;
        const outcome = refreshLock(filePath, held, at);
        if (outcome === 'lost') {
          // Another run may now be working on the state files: stop refreshing
          // and say so, since nothing else would surface it
          held.lost = true;
          clearInterval(timer);
          logger.warn('Run lock was removed or taken over while held; this run no longer holds it', { lockFile: filePath, pid: process.pid });
        } else if (outcome === 'failed') {
          logger.warn('Could not refresh the run lock; it ages out if this keeps failing', { lockFile: filePath });
        }
        return outcome === 'refreshed';
      };
      // Unref'd: a held lock must not keep a finished process alive.
      // The timer only fires while the event loop is free, so every long wait
      // in a locked run (installs, test suites, git, gh) must stay async: a
      // spawnSync/execSync would block refreshes until the lock aged out.
      // test/run-lock.test.js fails if src/ starts using those; code that must
      // block for long should call lock.refresh() around the wait instead.
      timer = setInterval(() => refresh(), refreshMs);
      timer.unref();
      return {
        acquired: true,
        refresh,
        // True once a refresh found the lock gone or someone else's
        get lost() { return held.lost; },
        release: () => {
          clearInterval(timer);
          releaseRunLock(filePath, held.raw);
        }
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }

    const raw = readRaw(filePath);
    const holder = parseLock(raw);
    if (attempt > 0 || !isStale(holder, raw, filePath, now)) {
      return { acquired: false, holder };
    }
    reclaimStaleLock(filePath, raw);
  }
}

function releaseRunLock(filePath, contents) {
  if (heldLocks.get(filePath) === contents) heldLocks.delete(filePath);
  // Only remove the lock if it is still this acquisition's (it may have been
  // reclaimed as stale, or released and taken again by this same process)
  if (readRaw(filePath) === contents) {
    fs.rmSync(filePath, { force: true });
  }
}
