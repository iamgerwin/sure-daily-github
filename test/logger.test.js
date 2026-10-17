import test from 'node:test';
import assert from 'node:assert/strict';

import logger, { resolveLogLevel } from '../src/utils/logger.js';

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
