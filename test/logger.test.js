import test from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import logger, { Logger, invalidLogLevel, resolveLogLevel, resolveRetentionDays, shouldUseColor } from '../src/utils/logger.js';

function withLogLevel(value, fn) {
  const original = process.env.LOG_LEVEL;
  if (value === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = value;
  try {
    fn();
  } finally {
    if (original === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = original;
  }
}

test('resolveLogLevel accepts known levels case-insensitively', () => {
  assert.equal(resolveLogLevel('debug'), 'debug');
  assert.equal(resolveLogLevel('WARN'), 'warn');
  assert.equal(resolveLogLevel(' Error '), 'error');
});

test('resolveLogLevel falls back to info for missing or unknown values', () => {
  assert.equal(resolveLogLevel(undefined), 'info');
  assert.equal(resolveLogLevel(''), 'info');
  assert.equal(resolveLogLevel('verbose'), 'info');
  assert.equal(resolveLogLevel('toString'), 'info');
});

test('an unknown LOG_LEVEL still logs errors', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-logger-'));
  try {
    const fileLogger = new Logger({ logDir: dir, color: false });
    captureConsole(() => withLogLevel('verbose', () => {
      assert.equal(fileLogger.shouldLog('error'), true);
      assert.equal(fileLogger.shouldLog('info'), true);
      assert.equal(fileLogger.shouldLog('debug'), false);
    }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('invalidLogLevel names only a set value that is not a level', () => {
  assert.equal(invalidLogLevel(undefined), null);
  assert.equal(invalidLogLevel(''), null);
  assert.equal(invalidLogLevel('  '), null);
  assert.equal(invalidLogLevel('debug'), null);
  assert.equal(invalidLogLevel(' WARN '), null);
  assert.equal(invalidLogLevel('deubg'), 'deubg');
  assert.equal(invalidLogLevel('toString'), 'toString');
});

test('an unknown LOG_LEVEL is warned about once per value, in the console and the log file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-logger-'));
  try {
    const fileLogger = new Logger({ logDir: dir, color: false });
    const lines = captureConsole(() => {
      withLogLevel('deubg', () => {
        fileLogger.info('first');
        fileLogger.info('second');
      });
      withLogLevel('verbose', () => fileLogger.info('third'));
      withLogLevel('debug', () => fileLogger.info('fourth'));
    });
    const warnings = lines.error.filter(line => /Ignoring LOG_LEVEL/.test(line));
    assert.equal(warnings.length, 2);
    assert.match(warnings[0], /\[WARN\].*logging at info.*"value":"deubg"/);
    assert.match(warnings[1], /"value":"verbose"/);
    assert.equal(lines.log.filter(line => /\] (first|second|third|fourth)$/.test(line)).length, 4);
    const [file] = fs.readdirSync(dir);
    assert.match(fs.readFileSync(path.join(dir, file), 'utf8'), /Ignoring LOG_LEVEL.*"value":"deubg"/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a valid or unset LOG_LEVEL is not warned about', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-logger-'));
  try {
    const fileLogger = new Logger({ logDir: dir, color: false });
    const lines = captureConsole(() => {
      withLogLevel(undefined, () => fileLogger.info('unset'));
      withLogLevel('', () => fileLogger.info('blank'));
      withLogLevel(' INFO ', () => fileLogger.info('padded'));
    });
    assert.equal(lines.error.filter(line => /Ignoring LOG_LEVEL/.test(line)).length, 0);
    assert.equal(lines.log.length, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('uppercase LOG_LEVEL is honored', () => {
  withLogLevel('DEBUG', () => {
    assert.equal(logger.shouldLog('debug'), true);
  });
  withLogLevel('ERROR', () => {
    assert.equal(logger.shouldLog('warn'), false);
    assert.equal(logger.shouldLog('error'), true);
  });
});

test('LOG_LEVEL set after import (as dotenv does) takes effect', () => {
  withLogLevel(undefined, () => {
    assert.equal(logger.shouldLog('debug'), false);
    process.env.LOG_LEVEL = 'debug';
    assert.equal(logger.shouldLog('debug'), true);
  });
});

function captureConsole(fn) {
  const original = { log: console.log, error: console.error };
  const lines = { log: [], error: [] };
  console.log = (line) => lines.log.push(line);
  console.error = (line) => lines.error.push(line);
  try {
    fn();
  } finally {
    console.log = original.log;
    console.error = original.error;
  }
  return lines;
}

test('an unusable log directory falls back to console output without throwing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-logger-'));
  const blocker = path.join(dir, 'not-a-dir');
  fs.writeFileSync(blocker, '');
  try {
    const lines = captureConsole(() => {
      const fileLogger = new Logger({ logDir: path.join(blocker, 'logs') });
      fileLogger.error('first failure', { repo: 'a/b' });
      fileLogger.error('second failure');
    });
    assert.equal(lines.error.length, 3);
    assert.match(lines.error[0], /logging to console only/);
    assert.match(lines.error[1], /first failure/);
    assert.match(lines.error[2], /second failure/);
    assert.equal(lines.error.filter(line => /logging to console only/.test(line)).length, 1, 'file failure is reported once');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a log directory removed after startup is recreated', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-logger-'));
  const logDir = path.join(dir, 'logs');
  try {
    const lines = captureConsole(() => {
      const fileLogger = new Logger({ logDir });
      fs.rmSync(logDir, { recursive: true });
      fileLogger.info('after removal');
    });
    assert.equal(lines.error.length, 0, 'no file failure is reported');
    const [file] = fs.readdirSync(logDir);
    assert.match(fs.readFileSync(path.join(logDir, file), 'utf8'), /after removal/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('unserializable meta is logged without throwing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-logger-'));
  try {
    const circular = {};
    circular.self = circular;
    const lines = captureConsole(() => {
      const fileLogger = new Logger({ logDir: dir });
      fileLogger.error('circular meta', circular);
      fileLogger.error('bigint meta', { id: 1n });
    });
    assert.match(lines.error[0], /circular meta \[unserializable meta: /);
    assert.match(lines.error[1], /bigint meta \[unserializable meta: /);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('shouldUseColor colors only a terminal without NO_COLOR', () => {
  assert.equal(shouldUseColor({ isTTY: true }, {}), true);
  assert.equal(shouldUseColor({ isTTY: false }, {}), false);
  assert.equal(shouldUseColor({}, {}), false);
  assert.equal(shouldUseColor(undefined, {}), false);
  assert.equal(shouldUseColor({ isTTY: true }, { NO_COLOR: '1' }), false);
  // An empty NO_COLOR does not count as set
  assert.equal(shouldUseColor({ isTTY: true }, { NO_COLOR: '' }), true);
});

test('console output carries color escapes only when color is on', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-logger-'));
  try {
    const lines = captureConsole(() => {
      new Logger({ logDir: dir, color: false }).error('plain line');
      new Logger({ logDir: dir, color: true }).error('colored line');
    });
    assert.doesNotMatch(lines.error[0], /\x1b\[/);
    assert.match(lines.error[0], /^\[.+\] \[ERROR\] plain line$/);
    assert.match(lines.error[1], /^\x1b\[31m.*colored line\x1b\[0m$/);
    const [file] = fs.readdirSync(dir);
    assert.doesNotMatch(fs.readFileSync(path.join(dir, file), 'utf8'), /\x1b\[/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('color is detected per write so NO_COLOR set after construction applies', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-logger-'));
  const originalTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  const originalNoColor = process.env.NO_COLOR;
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  try {
    delete process.env.NO_COLOR;
    const fileLogger = new Logger({ logDir: dir });
    const lines = captureConsole(() => {
      fileLogger.info('before');
      process.env.NO_COLOR = '1';
      fileLogger.info('after');
    });
    assert.match(lines.log[0], /\x1b\[36m/);
    assert.doesNotMatch(lines.log[1], /\x1b\[/);
  } finally {
    if (originalTTY) Object.defineProperty(process.stdout, 'isTTY', originalTTY);
    else delete process.stdout.isTTY;
    if (originalNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = originalNoColor;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('errors and warnings go to stderr, info and debug to stdout', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-logger-'));
  const originalLevel = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = 'debug';
  try {
    const lines = captureConsole(() => {
      const fileLogger = new Logger({ logDir: dir, color: false });
      fileLogger.error('an error');
      fileLogger.warn('a warning');
      fileLogger.info('some info');
      fileLogger.debug('some detail');
    });
    assert.equal(lines.error.length, 2);
    assert.match(lines.error[0], /\[ERROR\] an error$/);
    assert.match(lines.error[1], /\[WARN\] a warning$/);
    assert.equal(lines.log.length, 2);
    assert.match(lines.log[0], /\[INFO\] some info$/);
    assert.match(lines.log[1], /\[DEBUG\] some detail$/);
    // The daily file still holds every level, in order
    const [file] = fs.readdirSync(dir);
    const written = fs.readFileSync(path.join(dir, file), 'utf8').trim().split('\n');
    assert.deepEqual(written.map(line => line.match(/\[(\w+)\] /)[1]), ['ERROR', 'WARN', 'INFO', 'DEBUG']);
  } finally {
    if (originalLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = originalLevel;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('stderr lines are colored by whether stderr, not stdout, is a terminal', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-logger-'));
  const original = {
    out: Object.getOwnPropertyDescriptor(process.stdout, 'isTTY'),
    err: Object.getOwnPropertyDescriptor(process.stderr, 'isTTY')
  };
  const originalNoColor = process.env.NO_COLOR;
  delete process.env.NO_COLOR;
  // A terminal on stdout with stderr redirected to a file, as `2>errors.log` does
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  Object.defineProperty(process.stderr, 'isTTY', { value: false, configurable: true });
  try {
    const lines = captureConsole(() => {
      const fileLogger = new Logger({ logDir: dir });
      fileLogger.error('to the file');
      fileLogger.info('to the terminal');
    });
    assert.doesNotMatch(lines.error[0], /\x1b\[/);
    assert.match(lines.log[0], /\x1b\[36m/);
  } finally {
    for (const [stream, descriptor] of [[process.stdout, original.out], [process.stderr, original.err]]) {
      if (descriptor) Object.defineProperty(stream, 'isTTY', descriptor);
      else delete stream.isTTY;
    }
    if (originalNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = originalNoColor;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveRetentionDays accepts only positive whole numbers', () => {
  assert.equal(resolveRetentionDays('7'), 7);
  assert.equal(resolveRetentionDays(' 30 '), 30);
  for (const value of [undefined, '', '0', '-3', '1.5', 'abc', '7d']) {
    assert.equal(resolveRetentionDays(value), null, `${JSON.stringify(value)} should disable retention`);
  }
});

function withRetention(value, fn) {
  const original = process.env.LOG_RETENTION_DAYS;
  if (value === undefined) delete process.env.LOG_RETENTION_DAYS;
  else process.env.LOG_RETENTION_DAYS = value;
  try {
    fn();
  } finally {
    if (original === undefined) delete process.env.LOG_RETENTION_DAYS;
    else process.env.LOG_RETENTION_DAYS = original;
  }
}

function seedLogs(dir, names) {
  for (const name of names) fs.writeFileSync(path.join(dir, name), 'old\n');
}

test('pruneOldLogs keeps the last N daily files and leaves other files alone', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-logger-'));
  try {
    seedLogs(dir, ['2026-10-20.log', '2026-10-27.log', '2026-10-28.log', '2026-10-30.log',
      'systemd.log', 'cron.log', '2026-10-01.log.gz', 'notes-2026-10-01.log']);
    const fileLogger = new Logger({ logDir: dir });
    const removed = fileLogger.pruneOldLogs(3, new Date('2026-10-30T12:00:00Z'));
    assert.deepEqual(removed.sort(), ['2026-10-20.log', '2026-10-27.log']);
    assert.deepEqual(fs.readdirSync(dir).sort(), [
      '2026-10-01.log.gz', '2026-10-28.log', '2026-10-30.log', 'cron.log', 'notes-2026-10-01.log', 'systemd.log'
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pruneOldLogs on a missing directory returns nothing without throwing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-logger-'));
  try {
    const fileLogger = new Logger({ logDir: dir });
    fs.rmSync(dir, { recursive: true });
    assert.deepEqual(fileLogger.pruneOldLogs(1), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a LOG_RETENTION_DAYS past the representable date range keeps every file and never throws', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-logger-'));
  try {
    seedLogs(dir, ['2000-01-01.log']);
    const fileLogger = new Logger({ logDir: dir, color: false });
    assert.deepEqual(fileLogger.pruneOldLogs(999999999, new Date('2026-10-30T12:00:00Z')), []);

    captureConsole(() => {
      withRetention('999999999', () => {
        assert.doesNotThrow(() => new Logger({ logDir: dir, color: false }).error('still logged'));
      });
    });
    assert.ok(fs.existsSync(path.join(dir, '2000-01-01.log')), 'nothing is pruned');
    // Read back whichever daily file write() chose instead of re-reading the
    // clock, which could name the next day's file across midnight UTC
    const written = fs.readdirSync(dir).filter(name => name !== '2000-01-01.log');
    assert.equal(written.length, 1);
    assert.match(written[0], /^\d{4}-\d{2}-\d{2}\.log$/);
    assert.match(fs.readFileSync(path.join(dir, written[0]), 'utf8'), /still logged/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pruneOldLogs keeps every file when the retention reaches past the Date range', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-logger-'));
  try {
    seedLogs(dir, ['2000-01-01.log', '2026-10-30.log']);
    const fileLogger = new Logger({ logDir: dir });
    assert.deepEqual(fileLogger.pruneOldLogs(999999999, new Date('2026-10-30T12:00:00Z')), []);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['2000-01-01.log', '2026-10-30.log']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a huge LOG_RETENTION_DAYS still writes the line instead of throwing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-logger-'));
  try {
    seedLogs(dir, ['2000-01-01.log']);
    captureConsole(() => {
      withRetention('999999999', () => new Logger({ logDir: dir, color: false }).error('still logged'));
    });
    assert.ok(fs.existsSync(path.join(dir, '2000-01-01.log')), 'old file is kept');
    const today = `${new Date().toISOString().split('T')[0]}.log`;
    assert.match(fs.readFileSync(path.join(dir, today), 'utf8'), /still logged/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writing a line prunes old daily logs only when LOG_RETENTION_DAYS is set', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-logger-'));
  try {
    seedLogs(dir, ['2000-01-01.log']);
    captureConsole(() => {
      withRetention(undefined, () => new Logger({ logDir: dir, color: false }).error('kept'));
    });
    assert.ok(fs.existsSync(path.join(dir, '2000-01-01.log')), 'no retention keeps every file');

    captureConsole(() => {
      withRetention('2', () => new Logger({ logDir: dir, color: false }).error('pruned'));
    });
    assert.ok(!fs.existsSync(path.join(dir, '2000-01-01.log')), 'retention deletes the old file');
    const today = `${new Date().toISOString().split('T')[0]}.log`;
    assert.match(fs.readFileSync(path.join(dir, today), 'utf8'), /pruned/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pruning runs once per day, not on every line', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-logger-'));
  try {
    const fileLogger = new Logger({ logDir: dir });
    let scans = 0;
    fileLogger.pruneOldLogs = () => { scans++; return []; };
    withRetention('7', () => {
      fileLogger.pruneIfDue(new Date('2026-10-30T01:00:00Z'));
      fileLogger.pruneIfDue(new Date('2026-10-30T23:00:00Z'));
      assert.equal(scans, 1);
      fileLogger.pruneIfDue(new Date('2026-10-31T00:00:01Z'));
      assert.equal(scans, 2);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a line written across midnight UTC goes to the file of the day it is stamped with', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-logger-'));
  const RealDate = globalThis.Date;
  // Every argument-less clock read moves past midnight, as the real clock can
  // between two reads made for the same line
  const readings = [Date.parse('2026-11-16T23:59:59.999Z'), Date.parse('2026-11-17T00:00:00.000Z')];
  let reads = 0;
  globalThis.Date = class extends RealDate {
    constructor(...args) {
      if (args.length > 0) super(...args);
      else super(readings[Math.min(reads++, readings.length - 1)]);
    }
  };
  try {
    const fileLogger = new Logger({ logDir: dir, color: false });
    captureConsole(() => withLogLevel('info', () => fileLogger.info('at midnight')));
    globalThis.Date = RealDate;
    const files = fs.readdirSync(dir);
    assert.deepEqual(files, ['2026-11-16.log']);
    assert.match(fs.readFileSync(path.join(dir, files[0]), 'utf8'), /^\[2026-11-16T23:59:59\.999Z\] \[INFO\] at midnight/);
  } finally {
    globalThis.Date = RealDate;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
