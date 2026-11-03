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

test('ledgerKey ignores the case of the configured owner and repo', () => {
  assert.equal(ledgerKey('Me', 'Demo', 7), KEY);
});

test('a finished attempt is still skipped after the configured name changes case', (t) => {
  const { ledger } = tmpLedger(t);
  ledger.start(ledgerKey('Me', 'Demo', 7), 'sha1', 0);
  ledger.finish(ledgerKey('Me', 'Demo', 7), 'needs-manual-review', 0);

  assert.equal(ledger.skipReason(ledgerKey('me', 'demo', 7), 'sha1', { now: MINUTE, ...windows }), 'already-attempted');
});

test('entries saved under a mixed-case key are read under the lowercase key', (t) => {
  const { ledger } = tmpLedger(t);
  ledger.save({
    'Me/Demo#7': { headSha: 'sha1', status: 'failed', startedAt: 0, finishedAt: 0 },
    'Me/Demo#9': { headSha: 'old', status: 'failed', startedAt: 0, finishedAt: 0 },
    'me/demo#9': { headSha: 'new', status: 'fixed', startedAt: 5, finishedAt: 6 }
  });

  const entries = ledger.load();
  assert.deepEqual(Object.keys(entries).sort(), [KEY, 'me/demo#9']);
  assert.equal(entries['me/demo#9'].headSha, 'new', 'the latest attempt wins when two spellings collide');
  assert.equal(ledger.skipReason(KEY, 'sha1', { now: MINUTE, ...windows }), 'already-attempted');

  ledger.finish(KEY, 'error', 2);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(ledger.filePath, 'utf8'))).sort(), [KEY, 'me/demo#9']);
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

test('a corrupted ledger is kept as .bak before the next save replaces it', (t) => {
  const { ledger } = tmpLedger(t);
  fs.mkdirSync(path.dirname(ledger.filePath), { recursive: true });
  for (const content of ['{"me/demo#7": ', '[]']) {
    fs.writeFileSync(ledger.filePath, content);
    ledger.start(KEY, 'sha1', 0);

    assert.equal(fs.readFileSync(`${ledger.filePath}.bak`, 'utf8'), content, content);
    assert.equal(ledger.load()[KEY].headSha, 'sha1');
  }
});

test('a missing or valid ledger leaves no .bak behind', (t) => {
  const { ledger } = tmpLedger(t);
  ledger.start(KEY, 'sha1', 0);
  ledger.finish(KEY, 'fixed', 1);
  assert.equal(fs.existsSync(`${ledger.filePath}.bak`), false);
});

test('a failed save removes its temp file and rethrows', (t) => {
  const { ledger } = tmpLedger(t);
  // A directory at the ledger path makes the rename fail after the temp file is written
  fs.mkdirSync(ledger.filePath, { recursive: true });
  assert.throws(() => ledger.start(KEY, 'sha1', 1000));
  assert.deepEqual(fs.readdirSync(path.dirname(ledger.filePath)), ['state.json']);
});

test('starting an attempt prunes entries past the longer window and keeps the rest', (t) => {
  const { ledger } = tmpLedger(t);
  const now = 1000 * MINUTE;
  ledger.save({
    'me/demo#1': { headSha: 'a', status: 'fixed', startedAt: 0, finishedAt: now - 240 * MINUTE },
    'me/demo#2': { headSha: 'b', status: 'failed', startedAt: 0, finishedAt: now - 239 * MINUTE },
    'me/demo#3': { headSha: 'c', status: 'in-progress', startedAt: now - 240 * MINUTE, finishedAt: null },
    'me/demo#4': { headSha: 'd', status: 'in-progress', startedAt: now - 30 * MINUTE, finishedAt: null },
    'me/demo#5': { headSha: 'e', status: 'interrupted', startedAt: 0, finishedAt: now - 500 * MINUTE },
    'me/demo#6': 'garbage'
  });

  ledger.start(KEY, 'sha1', now, windows);

  assert.deepEqual(Object.keys(ledger.load()).sort(), ['me/demo#2', 'me/demo#4', KEY].sort());
});

test('pruning never drops an entry that would still cause a skip', (t) => {
  const { ledger } = tmpLedger(t);
  const now = 1000 * MINUTE;
  const blocking = ledgerKey('me', 'demo', 2);
  ledger.start(blocking, 'sha2', now - 239 * MINUTE);
  ledger.finish(blocking, 'needs-manual-review', now - 239 * MINUTE);

  ledger.start(KEY, 'sha1', now, windows);

  assert.equal(ledger.skipReason(blocking, 'sha2', { now, ...windows }), 'already-attempted');
});

test('starting an attempt without windows prunes nothing', (t) => {
  const { ledger } = tmpLedger(t);
  const old = { headSha: 'a', status: 'fixed', startedAt: 0, finishedAt: 0 };
  ledger.save({ 'me/demo#1': old });

  ledger.start(KEY, 'sha1', 1000 * MINUTE);

  assert.deepEqual(ledger.load()['me/demo#1'], old);
});
