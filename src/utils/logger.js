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

class Logger {
  constructor() {
    this.level = process.env.LOG_LEVEL || 'info';
    this.logDir = path.join(__dirname, '../../logs');
    this.ensureLogDir();
  }

  ensureLogDir() {
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
  }

  shouldLog(level) {
    return LOG_LEVELS[level] <= LOG_LEVELS[this.level];
  }

  format(level, message, meta = {}) {
    const timestamp = new Date().toISOString();
    const metaStr = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
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
    fs.appendFileSync(logFile, formatted + '\n');
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
