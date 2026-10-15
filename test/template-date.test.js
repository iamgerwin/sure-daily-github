import test from 'node:test';
import assert from 'node:assert/strict';

import { getTemplateDateParts } from '../src/utils/template-date.js';

// 2026-10-14T23:30:05Z is already Oct 15 in Asia/Manila (UTC+8)
const now = new Date('2026-10-14T23:30:05Z');

test('date and time follow the configured timezone', () => {
  assert.deepEqual(getTemplateDateParts('Asia/Manila', now), {
    date: '2026-10-15',
    time: '07:30:05',
    timestamp: '2026-10-14T23:30:05.000Z'
  });
});

test('defaults to UTC', () => {
  const parts = getTemplateDateParts(undefined, now);
  assert.equal(parts.date, '2026-10-14');
  assert.equal(parts.time, '23:30:05');
});

test('midnight renders as 00, not 24', () => {
  const parts = getTemplateDateParts('UTC', new Date('2026-10-15T00:00:00Z'));
  assert.equal(parts.date, '2026-10-15');
  assert.equal(parts.time, '00:00:00');
});

test('negative offsets roll back to the previous local day', () => {
  const parts = getTemplateDateParts('America/Los_Angeles', new Date('2026-10-15T03:00:00Z'));
  assert.equal(parts.date, '2026-10-14');
  assert.equal(parts.time, '20:00:00');
});
