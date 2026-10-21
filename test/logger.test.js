import test from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import logger, { Logger, resolveLogLevel } from '../src/utils/logger.js';

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
