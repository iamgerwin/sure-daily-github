import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { PrMaintLedger, emptyState, repoState } from '../src/utils/pr-maint-ledger.js';

function tmpLedger(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-pr-maint-ledger-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'nested', 'state.json');
  return { filePath, ledger: new PrMaintLedger({ filePath }) };
}

function writeRaw(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

test('PrMaintLedger reads its path from SDG_PR_MAINT_STATE_FILE', (t) => {
  process.env.SDG_PR_MAINT_STATE_FILE = '/tmp/custom-pr-maint.json';
  t.after(() => delete process.env.SDG_PR_MAINT_STATE_FILE);
  assert.equal(new PrMaintLedger().filePath, '/tmp/custom-pr-maint.json');
});

test('a missing, unparsable or non-object ledger loads as the empty state', (t) => {
  const { filePath, ledger } = tmpLedger(t);
  assert.deepEqual(ledger.load(), emptyState());
  for (const content of ['{not json', 'null', '[]', '"text"', '42']) {
    writeRaw(filePath, content);
    assert.deepEqual(ledger.load(), emptyState(), content);
  }
});

test('save then load round-trips and leaves no temp file behind', (t) => {
  const { filePath, ledger } = tmpLedger(t);
  const state = {
    breaker: { trippedAt: 1, until: 2, from: 'act', to: 'shadow', reason: 'rate: cap', pr: 3 },
    writes: [10, 20],
    repos: { 'me/demo': { prs: { 7: { stickyCommentId: 9 } }, escalations: {}, dashboard: { number: 1 } } }
  };
  ledger.save(state);
  assert.deepEqual(ledger.load(), state);
  assert.deepEqual(fs.readdirSync(path.dirname(filePath)), ['state.json']);
});

test('fields of the wrong shape fall back to defaults and keep the rest', (t) => {
  const { filePath, ledger } = tmpLedger(t);
  writeRaw(filePath, JSON.stringify({
    breaker: 'tripped',
    writes: { 0: 1 },
    repos: null,
    extra: 'kept'
  }));
  assert.deepEqual(ledger.load(), { ...emptyState(), extra: 'kept' });

  writeRaw(filePath, JSON.stringify({ breaker: { until: 'later' }, writes: [5, null, 'x', 6], repos: [] }));
  assert.deepEqual(ledger.load(), { breaker: null, writes: [5, 6], repos: {} });
});

test('the loaded state works with the executor write-window filter', (t) => {
  const { filePath, ledger } = tmpLedger(t);
  writeRaw(filePath, JSON.stringify({ writes: 'oops', repos: { 'me/demo': null } }));
  const state = ledger.load();
  // The same expression the pr-maint executor uses to count recent writes
  assert.deepEqual((state.writes || []).filter(at => at > 0), []);
  assert.deepEqual(repoState(state, 'me', 'demo'), { prs: {}, escalations: {}, dashboard: {} });
});

test('repoState keys repositories case-insensitively and repairs bad sub-fields', () => {
  const state = emptyState();
  state.repos['me/demo'] = { prs: 'bad', escalations: [], dashboard: null, extra: 1 };
  const entry = repoState(state, 'Me', 'Demo');
  assert.deepEqual(entry, { prs: {}, escalations: {}, dashboard: {}, extra: 1 });
  entry.prs['7'] = { stickyCommentId: 1 };
  assert.equal(repoState(state, 'me', 'demo').prs['7'].stickyCommentId, 1);
});

test('repoState keeps existing well-formed entries untouched', () => {
  const state = emptyState();
  const prs = { 1: { a: 1 } };
  state.repos['me/demo'] = { prs, escalations: {}, dashboard: { number: 4 } };
  const entry = repoState(state, 'me', 'demo');
  assert.equal(entry.prs, prs);
  assert.equal(entry.dashboard.number, 4);
});

test('a failed save removes its temp file and rethrows', (t) => {
  const { filePath, ledger } = tmpLedger(t);
  // A directory at the ledger path makes the rename fail after the temp file is written
  fs.mkdirSync(filePath, { recursive: true });
  assert.throws(() => ledger.save(emptyState()));
  assert.deepEqual(fs.readdirSync(path.dirname(filePath)), ['state.json']);
});
