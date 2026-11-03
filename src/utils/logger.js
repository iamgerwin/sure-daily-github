import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_LEVELS = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3
};

// Unknown values (e.g. "verbose") would otherwise compare against undefined and
// silence every log line, errors included
export function resolveLogLevel(value) {
  const level = String(value ?? '').trim().toLowerCase();
  return Object.hasOwn(LOG_LEVELS, level) ? level : 'info';
}

// Color escapes only help a terminal: under systemd, pm2, cron or a pipe they
// land in the captured output as literal "[36m" noise. A non-empty NO_COLOR
// (https://no-color.org) turns them off on a terminal too.
export function shouldUseColor(stream = process.stdout, env = process.env) {
  return Boolean(stream?.isTTY) && !env.NO_COLOR;
}

// Daily log files kept by LOG_RETENTION_DAYS (today included). Unset, zero or
// anything but a whole number keeps every file, as before.
export function resolveRetentionDays(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) return null;
  const days = Number(text);
  return days >= 1 ? days : null;
}

// Only the logger's own YYYY-MM-DD.log files; systemd.log, cron.log and other
// files sharing the directory are never touched
const DAILY_LOG_FILE = /^(\d{4}-\d{2}-\d{2})\.log$/;
const DAY_MS = 24 * 60 * 60 * 1000;

// Logging is called from inside catch blocks, so it must never throw: an
// unwritable log directory (read-only mount, permissions, full disk) or
// unserializable meta falls back to console-only output instead of crashing
export class Logger {
  // `color` forces colored console output on or off; unset detects it per write
  constructor({ logDir = path.join(__dirname, '../../logs'), color } = {}) {
    this.logDir = logDir;
    this.color = color;
    this.fileErrorReported = false;
    this.lastPrunedDay = null;
    this.ensureLogDir();
  }

  // Deletes daily log files more than `days` days old. File names (and today)
  // are UTC dates, matching the names write() gives them. Never throws.
  pruneOldLogs(days, now = new Date()) {
    const cutoff = new Date(now.getTime() - (days - 1) * DAY_MS).toISOString().split('T')[0];
    let entries;
    try {
      entries = fs.readdirSync(this.logDir);
    } catch (_) {
      return [];
    }
    const removed = [];
    for (const name of entries) {
      const match = DAILY_LOG_FILE.exec(name);
      if (!match || match[1] >= cutoff) continue;
      try {
        fs.rmSync(path.join(this.logDir, name), { force: true });
        removed.push(name);
      } catch (_) {}
    }
    return removed;
  }

  // Once per day of writing, so a long-running scheduler keeps pruning without
  // scanning the directory on every line. Read like LOG_LEVEL, after dotenv.
  pruneIfDue(now = new Date()) {
    const days = resolveRetentionDays(process.env.LOG_RETENTION_DAYS);
    const today = now.toISOString().split('T')[0];
    if (days === null || this.lastPrunedDay === today) return;
    this.lastPrunedDay = today;
    this.pruneOldLogs(days, now);
  }

  ensureLogDir() {
    try {
      fs.mkdirSync(this.logDir, { recursive: true });
      return true;
    } catch (error) {
      this.reportFileError(error);
      return false;
    }
  }

  // Warn once per process so a broken log directory does not flood the console
  reportFileError(error) {
    if (this.fileErrorReported) return;
    this.fileErrorReported = true;
    console.error(`Log file output unavailable (${this.logDir}), logging to console only: ${error.message}`);
  }

  // Read on every call: this module is imported before loader.js runs
  // dotenv.config(), so LOG_LEVEL from .env is not set at construction time
  get level() {
    return resolveLogLevel(process.env.LOG_LEVEL);
  }

  shouldLog(level) {
    return LOG_LEVELS[level] <= LOG_LEVELS[this.level];
  }

  format(level, message, meta = {}) {
    const timestamp = new Date().toISOString();
    let metaStr = '';
    if (meta && Object.keys(meta).length > 0) {
      try {
        metaStr = ` ${JSON.stringify(meta)}`;
      } catch (error) {
        metaStr = ` [unserializable meta: ${error.message}]`;
      }
    }
    return `[${timestamp}] [${level.toUpperCase()}] ${message}${metaStr}`;
  }

  write(level, message, meta = {}) {
    if (!this.shouldLog(level)) return;

    const formatted = this.format(level, message, meta);

    // Console output with colors
    const colors = {
      error: '\x1b[31m',
      warn: '\x1b[33m',
      info: '\x1b[36m',
      debug: '\x1b[90m'
    };
    const reset = '\x1b[0m';
    // Detected on every call, like the level, so NO_COLOR from .env applies
    const color = this.color ?? shouldUseColor();
    console.log(color ? `${colors[level]}${formatted}${reset}` : formatted);

    // File output
    const now = new Date();
    this.pruneIfDue(now);
    const logFile = path.join(this.logDir, `${now.toISOString().split('T')[0]}.log`);
    try {
      fs.appendFileSync(logFile, formatted + '\n');
    } catch (error) {
      // A long-running scheduler can outlive a deleted logs directory: recreate it once
      if (error.code !== 'ENOENT' || !this.ensureLogDir()) {
        this.reportFileError(error);
        return;
      }
      try {
        fs.appendFileSync(logFile, formatted + '\n');
      } catch (retryError) {
        this.reportFileError(retryError);
      }
    }
  }

  error(message, meta) {
    this.write('error', message, meta);
  }

  warn(message, meta) {
    this.write('warn', message, meta);
  }

  info(message, meta) {
    this.write('info', message, meta);
  }

  debug(message, meta) {
    this.write('debug', message, meta);
  }
}

export default new Logger();
