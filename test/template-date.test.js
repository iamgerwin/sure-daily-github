import test from 'node:test';
import assert from 'node:assert/strict';

import { getTemplateDateParts, formatNextIssueTime } from '../src/utils/template-date.js';

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

test('next issue time on the same local day is HH:MM only', () => {
  // 01:00 and 07:30 on Oct 15 in Asia/Manila
  assert.equal(formatNextIssueTime('Asia/Manila', new Date('2026-10-14T23:30:05Z'), new Date('2026-10-14T17:00:00Z')), '07:30');
});

test('next issue time on a later local day carries its date', () => {
  // 23:30 on Oct 14 UTC, next issue at 02:00 on Oct 15
  assert.equal(formatNextIssueTime('UTC', new Date('2026-10-15T02:00:00Z'), new Date('2026-10-14T23:30:00Z')), '2026-10-15 02:00');
});

test('next issue day is compared in the configured timezone, not UTC', () => {
  // Both instants fall on Oct 15 in Asia/Manila although they straddle UTC midnight
  assert.equal(formatNextIssueTime('Asia/Manila', new Date('2026-10-15T01:00:00Z'), new Date('2026-10-14T23:00:00Z')), '09:00');
  // ...and on different days there, though both are Oct 14 in UTC
  assert.equal(formatNextIssueTime('Asia/Manila', new Date('2026-10-14T17:00:00Z'), new Date('2026-10-14T15:00:00Z')), '2026-10-15 01:00');
});
