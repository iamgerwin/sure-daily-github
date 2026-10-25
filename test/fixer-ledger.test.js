import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { FixerLedger, ledgerKey } from '../src/utils/fixer-ledger.js';

const MINUTE = 60 * 1000;
const windows = { attemptTtlMs: 60 * MINUTE, retryCooldownMs: 240 * MINUTE };
const KEY = ledgerKey('me', 'demo', 7);

function tmpLedger(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-ledger-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, ledger: new FixerLedger({ filePath: path.join(dir, 'nested', 'state.json') }) };
}

test('ledgerKey formats owner/repo#number', () => {
  assert.equal(KEY, 'me/demo#7');
});

test('FixerLedger reads its path from SDG_CONFLICT_FIXER_STATE_FILE', (t) => {
  process.env.SDG_CONFLICT_FIXER_STATE_FILE = '/tmp/custom-ledger.json';
  t.after(() => delete process.env.SDG_CONFLICT_FIXER_STATE_FILE);
  assert.equal(new FixerLedger().filePath, '/tmp/custom-ledger.json');
});

test('an in-progress attempt on the same SHA is skipped until the TTL expires', (t) => {
  const { ledger } = tmpLedger(t);
  ledger.start(KEY, 'sha1', 1000);

  assert.deepEqual(ledger.load()[KEY], { headSha: 'sha1', status: 'in-progress', startedAt: 1000, finishedAt: null });
  assert.equal(ledger.skipReason(KEY, 'sha1', { now: 1000 + 59 * MINUTE, ...windows }), 'already-in-progress');
  assert.equal(ledger.skipReason(KEY, 'sha1', { now: 1000 + 60 * MINUTE, ...windows }), null);
});

test('a finished attempt on the same SHA is skipped during the retry cooldown', (t) => {
  const { ledger } = tmpLedger(t);
  for (const status of ['fixed', 'needs-manual-review', 'error']) {
    ledger.start(KEY, 'sha1', 0);
    ledger.finish(KEY, status, 1000);
    assert.equal(ledger.skipReason(KEY, 'sha1', { now: 1000 + 239 * MINUTE, ...windows }), 'already-attempted');
    assert.equal(ledger.skipReason(KEY, 'sha1', { now: 1000 + 240 * MINUTE, ...windows }), null);
  }
  assert.equal(ledger.load()[KEY].status, 'failed');
});

test('a different head SHA is always eligible', (t) => {
  const { ledger } = tmpLedger(t);
  ledger.start(KEY, 'sha1', 1000);
  assert.equal(ledger.skipReason(KEY, 'sha2', { now: 1000, ...windows }), null);
  ledger.finish(KEY, 'fixed', 2000);
  assert.equal(ledger.skipReason(KEY, 'sha2', { now: 2000, ...windows }), null);
});

test('outcomes that are not attempts remove the entry', (t) => {
  const { ledger } = tmpLedger(t);
  for (const status of ['stale-status', 'head-moved', 'skipped']) {
    ledger.start(KEY, 'sha1', 0);
    ledger.finish(KEY, status, 1000);
    assert.equal(ledger.load()[KEY], undefined);
  }
});

test('markInterrupted only touches in-progress entries', (t) => {
  const { ledger } = tmpLedger(t);
  const other = ledgerKey('me', 'demo', 8);
  ledger.start(KEY, 'sha1', 0);
  ledger.start(other, 'sha2', 0);
  ledger.finish(other, 'fixed', 500);

  ledger.markInterrupted([KEY, other], 1000);

  assert.deepEqual(ledger.load()[KEY], { headSha: 'sha1', status: 'interrupted', startedAt: 0, finishedAt: 1000 });
  assert.equal(ledger.load()[other].status, 'fixed');
  // An interrupted attempt is retried on the next run
  assert.equal(ledger.skipReason(KEY, 'sha1', { now: 1000, ...windows }), null);
});

test('save writes through a temp file and leaves the old ledger intact on failure', (t) => {
  const { ledger } = tmpLedger(t);
  ledger.start(KEY, 'sha1', 0);
  const before = fs.readFileSync(ledger.filePath, 'utf8');
  assert.deepEqual(fs.readdirSync(path.dirname(ledger.filePath)), ['state.json']);

  // A directory at the temp path makes the write fail before the rename
  fs.mkdirSync(`${ledger.filePath}.${process.pid}.tmp`);
  assert.throws(() => ledger.start(KEY, 'sha2', 1));
  assert.equal(fs.readFileSync(ledger.filePath, 'utf8'), before);
});

test('a corrupted ledger is treated as empty', (t) => {
  const { ledger } = tmpLedger(t);
  fs.mkdirSync(path.dirname(ledger.filePath), { recursive: true });
  fs.writeFileSync(ledger.filePath, '{"me/demo#7": ');
  assert.deepEqual(ledger.load(), {});
});

test('a failed save removes its temp file and rethrows', (t) => {
  const { ledger } = tmpLedger(t);
  // A directory at the ledger path makes the rename fail after the temp file is written
  fs.mkdirSync(ledger.filePath, { recursive: true });
  assert.throws(() => ledger.start(KEY, 'sha1', 1000));
  assert.deepEqual(fs.readdirSync(path.dirname(ledger.filePath)), ['state.json']);
});
