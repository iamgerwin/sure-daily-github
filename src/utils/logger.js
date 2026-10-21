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

// Logging is called from inside catch blocks, so it must never throw: an
// unwritable log directory (read-only mount, permissions, full disk) or
// unserializable meta falls back to console-only output instead of crashing
export class Logger {
  constructor({ logDir = path.join(__dirname, '../../logs') } = {}) {
    this.logDir = logDir;
    this.fileErrorReported = false;
    this.ensureLogDir();
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
    console.log(`${colors[level]}${formatted}${reset}`);

    // File output
    const logFile = path.join(this.logDir, `${new Date().toISOString().split('T')[0]}.log`);
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
