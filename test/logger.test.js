import test from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import logger, { Logger, resolveLogLevel, shouldUseColor } from '../src/utils/logger.js';

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
  withLogLevel('verbose', () => {
    assert.equal(logger.shouldLog('error'), true);
    assert.equal(logger.shouldLog('info'), true);
    assert.equal(logger.shouldLog('debug'), false);
  });
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
    assert.equal(lines.log.length, 2);
    assert.match(lines.log[0], /first failure/);
    assert.equal(lines.error.length, 1, 'file failure is reported once');
    assert.match(lines.error[0], /logging to console only/);
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
      fileLogger.error('after removal');
    });
    assert.equal(lines.error.length, 0);
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
    assert.match(lines.log[0], /circular meta \[unserializable meta: /);
    assert.match(lines.log[1], /bigint meta \[unserializable meta: /);
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
    assert.doesNotMatch(lines.log[0], /\x1b\[/);
    assert.match(lines.log[0], /^\[.+\] \[ERROR\] plain line$/);
    assert.match(lines.log[1], /^\x1b\[31m.*colored line\x1b\[0m$/);
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
      fileLogger.error('before');
      process.env.NO_COLOR = '1';
      fileLogger.error('after');
    });
    assert.match(lines.log[0], /\x1b\[31m/);
    assert.doesNotMatch(lines.log[1], /\x1b\[/);
  } finally {
    if (originalTTY) Object.defineProperty(process.stdout, 'isTTY', originalTTY);
    else delete process.stdout.isTTY;
    if (originalNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = originalNoColor;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
