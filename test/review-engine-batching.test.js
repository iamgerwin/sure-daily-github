import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { MAX_BATCH_CHARS, batchBySize, runTriage, runImplement } from '../src/utils/review-engine.js';

const pr = { number: 7, title: 'Add thing', repoFullName: 'me/demo', headRef: 'feature', baseRef: 'main' };
const len = (s) => s.length;

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-batch-'));
}

test('batchBySize keeps every item in its original order across batches', () => {
  const items = ['aaa', 'bb', 'cccc', 'd', 'ee'];
  const batches = batchBySize(items, len, 5);
  assert.deepEqual(batches, [['aaa', 'bb'], ['cccc', 'd'], ['ee']]);
  assert.deepEqual(batches.flat(), items);
});

test('batchBySize fills a batch up to exactly the limit and starts a new one past it', () => {
  assert.deepEqual(batchBySize(['ab', 'cd'], len, 4), [['ab', 'cd']]);
  assert.deepEqual(batchBySize(['ab', 'cde'], len, 4), [['ab'], ['cde']]);
});

test('batchBySize gives an item larger than the limit a batch of its own', () => {
  const batches = batchBySize(['a', 'x'.repeat(10), 'b', 'c'], len, 3);
  assert.deepEqual(batches, [['a'], ['x'.repeat(10)], ['b', 'c']]);
});

test('batchBySize puts consecutive oversized items in separate batches', () => {
  const big = 'y'.repeat(8);
  assert.deepEqual(batchBySize([big, big], len, 3), [[big], [big]]);
});

test('batchBySize returns no batches for no items', () => {
  assert.deepEqual(batchBySize([], len, 10), []);
});

test('batchBySize keeps zero-size items together and defaults to MAX_BATCH_CHARS', () => {
  assert.deepEqual(batchBySize(['', '', ''], len, 1), [['', '', '']]);
  const half = 'z'.repeat(MAX_BATCH_CHARS / 2);
  assert.deepEqual(batchBySize([half, half, 'z'], len).map(b => b.length), [2, 1]);
});

// Answers each engine call by writing a decision for every id in its prompt to
// the file the prompt names, and records which file each call was told to use
function recordingRunner(fileOf, entry) {
  const files = [];
  const runner = async (cmd, args, opts) => {
    const file = fileOf(opts.input);
    files.push(file);
    const ids = [...opts.input.matchAll(/"id": "(review_comment:\d+)"/g)].map(m => m[1]);
    fs.writeFileSync(file, JSON.stringify(entry(ids)));
    return { code: 0, stdout: '', stderr: '' };
  };
  return { runner, files };
}

function oversizedComments(count) {
  return Array.from({ length: count }, (_, i) => ({
    id: `review_comment:${300 + i}`,
    kind: 'review_comment',
    author: 'alice',
    path: 'a.js',
    line: 1,
    body: String(i).repeat(MAX_BATCH_CHARS)
  }));
}

test('runTriage gives each batch its own numbered output file and merges their decisions', async () => {
  const dir = tmpDir();
  const outputFile = path.join(dir, 'triage.json');
  const { runner, files } = recordingRunner(
    input => input.match(/only output that is read\): (\S+)/)[1],
    ids => ({ comments: ids.map(id => ({ id, action: 'note', reasoning: 'ok' })) })
  );

  const result = await runTriage({
    engine: 'opencode', model: 'm', cwd: '/w', pr, comments: oversizedComments(3), diff: '', outputFile, runner
  });

  assert.deepEqual(files, [outputFile, path.join(dir, 'triage-2.json'), path.join(dir, 'triage-3.json')]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.decisions.map(d => d.id), ['review_comment:300', 'review_comment:301', 'review_comment:302']);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.batchFailures, []);
});

test('runImplement numbers report files without a .json extension by suffixing the name', async () => {
  const dir = tmpDir();
  const reportFile = path.join(dir, 'report');
  const items = oversizedComments(2).map(comment => ({ comment, decision: { action: 'fix', reasoning: 'r', plan: 'p' } }));
  const { runner, files } = recordingRunner(
    input => input.match(/write a JSON report to: (\S+)/)[1],
    ids => ({ fixes: ids.map(id => ({ id, status: 'implemented', summary: 's' })) })
  );

  const result = await runImplement({ engine: 'opencode', model: 'm', cwd: '/w', pr, items, reportFile, runner });

  assert.deepEqual(files, [reportFile, path.join(dir, 'report-2')]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.report.fixes.map(f => f.id), ['review_comment:300', 'review_comment:301']);
  assert.deepEqual(result.report.missing, []);
});

test('runTriage does not read a batch file left over from an earlier scan', async () => {
  const dir = tmpDir();
  const outputFile = path.join(dir, 'triage.json');
  const stale = JSON.stringify({ comments: [{ id: 'review_comment:301', action: 'fix', reasoning: 'stale' }] });
  fs.writeFileSync(path.join(dir, 'triage-2.json'), stale);
  // The engine answers the first batch only and exits cleanly on the second
  let call = 0;
  const runner = async (cmd, args, opts) => {
    if (++call === 1) {
      fs.writeFileSync(outputFile, JSON.stringify({ comments: [{ id: 'review_comment:300', action: 'note', reasoning: 'ok' }] }));
    }
    return { code: 0, stdout: '', stderr: '' };
  };

  const result = await runTriage({
    engine: 'opencode', model: 'm', cwd: '/w', pr, comments: oversizedComments(2), diff: '', outputFile, runner
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.decisions.map(d => d.id), ['review_comment:300']);
  assert.deepEqual(result.batchFailures, [
    { ids: ['review_comment:301'], infra: false, error: 'opencode did not write the triage file' }
  ]);
});
