import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runProcess, clampTimerMs, MAX_TIMER_MS } from '../src/utils/process.js';

const MAX_OUTPUT_CHARS = 256 * 1024;

test('runProcess keeps only the last 256 KiB of each stream so the final failure lines survive', async () => {
  // ~1 MiB of filler per stream, written in many chunks, then a marker last
  const script = `
    const filler = 'x'.repeat(1023) + '\\n';
    for (let i = 0; i < 1024; i++) { process.stdout.write(filler); process.stderr.write(filler); }
    process.stdout.write('STDOUT-TAIL-MARKER\\n');
    process.stderr.write('STDERR-TAIL-MARKER\\n');
  `;
  const result = await runProcess(process.execPath, ['-e', script]);
  assert.equal(result.code, 0);
  assert.equal(result.stdout.length, MAX_OUTPUT_CHARS);
  assert.equal(result.stderr.length, MAX_OUTPUT_CHARS);
  assert.ok(result.stdout.endsWith('STDOUT-TAIL-MARKER\n'));
  assert.ok(result.stderr.endsWith('STDERR-TAIL-MARKER\n'));
});

test('runProcess returns output under the cap untouched', async () => {
  const result = await runProcess(process.execPath, ['-e', 'process.stdout.write("a".repeat(1000)); process.stderr.write("b")']);
  assert.equal(result.stdout, 'a'.repeat(1000));
  assert.equal(result.stderr, 'b');
});

test('runProcess runs in the given cwd with exactly the given env', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-process-')));
  try {
    const result = await runProcess(
      process.execPath,
      ['-e', 'console.log(JSON.stringify({ cwd: process.cwd(), marker: process.env.SDG_MARKER ?? null, secret: process.env.SDG_SECRET ?? null }))'],
      { cwd: dir, env: { PATH: process.env.PATH, SDG_MARKER: 'set' } }
    );
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout), { cwd: dir, marker: 'set', secret: null });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runProcess reports the terminating signal of a timed-out command', async () => {
  const result = await runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { timeoutMs: 100 });
  assert.equal(result.timedOut, true);
  assert.equal(result.code, null);
  assert.equal(result.signal, 'SIGTERM');
  assert.equal(result.error, null);
});

test('clampTimerMs caps a delay at the 32-bit timer limit and leaves smaller delays alone', () => {
  assert.equal(MAX_TIMER_MS, 2 ** 31 - 1);
  assert.equal(clampTimerMs(1000), 1000);
  assert.equal(clampTimerMs(MAX_TIMER_MS), MAX_TIMER_MS);
  assert.equal(clampTimerMs(MAX_TIMER_MS + 1), MAX_TIMER_MS);
  assert.equal(clampTimerMs(30 * 24 * 60 * 60 * 1000), MAX_TIMER_MS);
});
