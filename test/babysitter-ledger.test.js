import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { BabysitterLedger, MAX_ATTEMPTS, MAX_DELIVERY_ATTEMPTS, PUSHED_STATE } from '../src/utils/babysitter-ledger.js';

function tmpLedgerPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-ledger-'));
  return path.join(dir, 'nested', 'babysitter-state.json');
}

const key = BabysitterLedger.commentKey('Me', 'Demo', 7, 'review_comment:11');

test('commentKey is case-insensitive on the repository and keeps the comment kind', () => {
  assert.equal(key, 'me/demo#7/review_comment:11');
  assert.notEqual(key, BabysitterLedger.commentKey('me', 'demo', 7, 'issue_comment:11'));
});

test('unknown comments are processed and settled comments are skipped', () => {
  const ledger = new BabysitterLedger({ filePath: tmpLedgerPath() });
  assert.equal(ledger.shouldProcess(key), true);

  for (const state of ['addressed', 'deferred', 'wontfix', 'noted']) {
    const k = `${key}-${state}`;
    ledger.recordOutcome(k, { state, pr: 7, headSha: 'abc', action: 'fix', replyId: 5, commitSha: 'def' });
    assert.equal(ledger.shouldProcess(k), false, `${state} must not be reprocessed`);
  }
});

test('recordOutcome stores the reply, commit, and head sha and rejects unknown states', () => {
  const ledger = new BabysitterLedger({ filePath: tmpLedgerPath() });
  ledger.recordOutcome(key, { state: 'addressed', pr: 7, headSha: 'abc', action: 'fix', replyId: 99, commitSha: 'def' });
  const entry = ledger.getComment(key);
  assert.equal(entry.state, 'addressed');
  assert.equal(entry.replyId, 99);
  assert.equal(entry.commitSha, 'def');
  assert.equal(entry.headSha, 'abc');
  assert.equal(entry.pr, 7);

  assert.throws(() => ledger.recordOutcome(key, { state: 'failed', pr: 7 }), /Invalid babysitter ledger state/);
  assert.throws(() => ledger.recordOutcome(key, { state: 'bogus', pr: 7 }), /Invalid babysitter ledger state/);
});

test('failures are retried until MAX_ATTEMPTS and then left alone', () => {
  const ledger = new BabysitterLedger({ filePath: tmpLedgerPath() });
  assert.equal(MAX_ATTEMPTS, 2);

  const first = ledger.recordFailure(key, { pr: 7, action: 'fix', error: 'tests failed' });
  assert.equal(first.attempts, 1);
  assert.equal(first.exhausted, false);
  assert.equal(ledger.shouldProcess(key), true);

  const second = ledger.recordFailure(key, { pr: 7, action: 'fix', error: 'tests failed again' });
  assert.equal(second.attempts, 2);
  assert.equal(second.exhausted, true);
  assert.equal(second.state, 'failed');
  assert.equal(ledger.shouldProcess(key), false);

  ledger.setReplyId(key, 123);
  assert.equal(ledger.getComment(key).replyId, 123);
});

test('a failure followed by success settles the comment', () => {
  const ledger = new BabysitterLedger({ filePath: tmpLedgerPath() });
  ledger.recordFailure(key, { pr: 7, error: 'boom' });
  ledger.recordOutcome(key, { state: 'deferred', pr: 7, replyId: 1 });
  assert.equal(ledger.getComment(key).state, 'deferred');
  assert.equal(ledger.getComment(key).attempts, 2);
  assert.equal(ledger.shouldProcess(key), false);
});

test('the ledger persists atomically and reloads across instances', () => {
  const filePath = tmpLedgerPath();
  const ledger = new BabysitterLedger({ filePath });
  ledger.recordOutcome(key, { state: 'noted', pr: 7, replyId: 3 });
  ledger.markForkNotified('me/demo#8', { replyId: 4 });

  const leftovers = fs.readdirSync(path.dirname(filePath)).filter(f => f.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);

  const reloaded = new BabysitterLedger({ filePath });
  assert.equal(reloaded.getComment(key).state, 'noted');
  assert.equal(reloaded.getPr('me/demo#8').forkNotice.replyId, 4);
  assert.equal(reloaded.shouldProcess(key), false);
});

test('a corrupt ledger is backed up and replaced with an empty one', (t) => {
  const filePath = tmpLedgerPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '{not json');

  const originalError = console.error;
  console.error = () => {};
  t.after(() => { console.error = originalError; });

  const ledger = new BabysitterLedger({ filePath });
  assert.equal(ledger.shouldProcess(key), true);
  assert.equal(fs.readFileSync(`${filePath}.bak`, 'utf8'), '{not json');

  for (const raw of ['[]', 'null', '42']) {
    fs.writeFileSync(filePath, raw);
    assert.deepEqual(new BabysitterLedger({ filePath }).data, { version: 1, comments: {}, prs: {}, deliveries: {}, pushIntents: {}, cursor: null });
  }
});

test('the ledger path defaults to SDG_BABYSITTER_STATE_FILE', (t) => {
  const filePath = tmpLedgerPath();
  process.env.SDG_BABYSITTER_STATE_FILE = filePath;
  t.after(() => { delete process.env.SDG_BABYSITTER_STATE_FILE; });

  new BabysitterLedger().recordOutcome(key, { state: 'noted', pr: 7 });
  assert.equal(fs.existsSync(filePath), true);
});

test('a pushed fix is not reprocessed and settles when its reply is delivered', () => {
  const filePath = tmpLedgerPath();
  const ledger = new BabysitterLedger({ filePath });
  ledger.recordOutcome(key, { state: PUSHED_STATE, pr: 7, action: 'fix', commitSha: 'def' }, { save: false });
  ledger.addDeliveries([{ id: `${key}#reply`, kind: 'inline', owner: 'me', repo: 'demo', pr: 7, pushedSha: 'def', body: 'b', keys: [key], states: { [key]: 'addressed' } }]);

  // Durable before any reply goes out
  const reloaded = new BabysitterLedger({ filePath });
  assert.equal(reloaded.getComment(key).state, PUSHED_STATE);
  assert.equal(reloaded.shouldProcess(key), false);
  assert.deepEqual(reloaded.getDeliveries().map(d => d.id), [`${key}#reply`]);

  const failed = reloaded.failDelivery(`${key}#reply`, 'HTTP 502');
  assert.equal(failed.exhausted, false);
  assert.equal(reloaded.getComment(key).state, 'addressed');
  assert.equal(reloaded.getComment(key).replyPending, true);
  assert.equal(reloaded.getDeliveries().length, 1);

  reloaded.completeDelivery(`${key}#reply`, 42);
  assert.equal(reloaded.getComment(key).replyId, 42);
  assert.equal(reloaded.getComment(key).replyPending, undefined);
  assert.deepEqual(reloaded.getDeliveries(), []);
});

test('a delivery that keeps failing is eventually dropped with a note', () => {
  const ledger = new BabysitterLedger({ filePath: tmpLedgerPath() });
  ledger.recordOutcome(key, { state: 'noted', pr: 7 }, { save: false });
  ledger.addDeliveries([{ id: 'd', kind: 'summary', owner: 'me', repo: 'demo', pr: 7, body: 'b', keys: [key], states: { [key]: 'noted' } }]);
  let last;
  for (let i = 0; i < MAX_DELIVERY_ATTEMPTS; i++) last = ledger.failDelivery('d', 'gone');
  assert.equal(last.exhausted, true);
  assert.deepEqual(ledger.getDeliveries(), []);
  assert.match(ledger.getComment(key).note, /reply abandoned after 10 attempts: gone/);
});

test('the scan cursor and interruption marks persist', () => {
  const filePath = tmpLedgerPath();
  const ledger = new BabysitterLedger({ filePath });
  assert.equal(ledger.getCursor(), null);
  ledger.setCursor({ repo: 'me/demo', number: 8 });
  ledger.markInterrupted('me/demo#8', { signal: 'SIGTERM' });
  const reloaded = new BabysitterLedger({ filePath });
  assert.deepEqual(reloaded.getCursor(), { repo: 'me/demo', number: 8 });
  assert.equal(reloaded.getPr('me/demo#8').interrupted.signal, 'SIGTERM');
});

test('save throws instead of silently dropping a record', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-ledger-'));
  // A regular file where the parent directory should be makes mkdir fail
  const blocker = path.join(dir, 'blocker');
  fs.writeFileSync(blocker, '');
  const ledger = new BabysitterLedger({ filePath: path.join(blocker, 'state.json') });
  assert.throws(() => ledger.recordOutcome(key, { state: 'noted', pr: 7 }), /Failed to save babysitter ledger/);
});
