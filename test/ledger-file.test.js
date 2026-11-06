import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { readLedgerObject } from '../src/utils/ledger-file.js';

function tmpFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-ledger-file-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'ledger.json');
}

function captureStderr(t) {
  const lines = [];
  t.mock.method(console, 'error', (...args) => lines.push(args.join(' ')));
  return lines;
}

test('a missing ledger reads as null without a report or .bak', (t) => {
  const filePath = tmpFile(t);
  const errors = captureStderr(t);

  assert.equal(readLedgerObject(filePath, 'test ledger'), null);
  assert.deepEqual(errors, []);
  assert.equal(fs.existsSync(`${filePath}.bak`), false);
});

test('a valid ledger object is returned as parsed', (t) => {
  const filePath = tmpFile(t);
  const errors = captureStderr(t);
  fs.writeFileSync(filePath, '{"me/demo#7": {"headSha": "abc"}}');

  assert.deepEqual(readLedgerObject(filePath, 'test ledger'), { 'me/demo#7': { headSha: 'abc' } });
  assert.deepEqual(errors, []);
});

test('an unparsable ledger is copied to .bak and the report says so', (t) => {
  const filePath = tmpFile(t);
  const errors = captureStderr(t);
  fs.writeFileSync(filePath, '{"me/demo#7": ');

  assert.equal(readLedgerObject(filePath, 'test ledger'), null);
  assert.equal(fs.readFileSync(`${filePath}.bak`, 'utf8'), '{"me/demo#7": ');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Error loading test ledger/);
  assert.match(errors[0], /the original is kept at .*ledger\.json\.bak/);
});

test('the same broken contents are reported once, new contents again', (t) => {
  const filePath = tmpFile(t);
  const errors = captureStderr(t);
  fs.writeFileSync(filePath, '[]');

  readLedgerObject(filePath, 'test ledger');
  readLedgerObject(filePath, 'test ledger');
  assert.equal(errors.length, 1);

  fs.writeFileSync(filePath, '"text"');
  readLedgerObject(filePath, 'test ledger');
  assert.equal(errors.length, 2);
  assert.equal(fs.readFileSync(`${filePath}.bak`, 'utf8'), '"text"');
});

test('a ledger that cannot be copied is not reported as kept at .bak', (t) => {
  const filePath = tmpFile(t);
  const errors = captureStderr(t);
  // A directory at the ledger path fails both the read and the copy
  fs.mkdirSync(filePath);

  assert.equal(readLedgerObject(filePath, 'test ledger'), null);
  assert.equal(fs.existsSync(`${filePath}.bak`), false);
  assert.equal(errors.length, 1);
  assert.doesNotMatch(errors[0], /is kept at/);
  assert.match(errors[0], /could not be copied to .*ledger\.json\.bak .*the next save replaces it/);
});

test('an unreadable (permission denied) ledger is not reported as kept at .bak', { skip: process.getuid?.() === 0 && 'root reads any file' }, (t) => {
  const filePath = tmpFile(t);
  const errors = captureStderr(t);
  fs.writeFileSync(filePath, '{"me/demo#7": {"headSha": "abc"}}');
  // Removing the temp directory unlinks the file regardless of its mode
  fs.chmodSync(filePath, 0o000);

  assert.equal(readLedgerObject(filePath, 'test ledger'), null);
  assert.equal(fs.existsSync(`${filePath}.bak`), false);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /EACCES/);
  assert.match(errors[0], /could not be copied/);
});
