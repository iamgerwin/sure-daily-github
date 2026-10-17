import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseConflicts,
  renderResolution,
  hasConflictMarkers,
  pickNewer,
  locateBlock,
  splitLines,
  ManualReviewError
} from '../src/core/conflict-resolver.js';

const diff3 = [
  'top\n',
  '<<<<<<< HEAD\n',
  'ours 1\n',
  '||||||| merged common ancestors\n',
  'base 1\n',
  '=======\n',
  'theirs 1\n',
  '>>>>>>> origin/master\n',
  'middle\n',
  '<<<<<<< HEAD\n',
  'ours 2\n',
  '||||||| base\n',
  'base 2\n',
  '=======\n',
  '>>>>>>> origin/master\n',
  'bottom\n'
].join('');

test('parseConflicts splits diff3 output into text and conflict segments', () => {
  const segments = parseConflicts(diff3);
  assert.deepEqual(segments.map(s => s.type), ['text', 'conflict', 'text', 'conflict', 'text']);
  assert.deepEqual(segments[1], { type: 'conflict', ours: ['ours 1\n'], base: ['base 1\n'], theirs: ['theirs 1\n'] });
  // An empty side means that side deleted the lines
  assert.deepEqual(segments[3].theirs, []);
  assert.deepEqual(segments[3].ours, ['ours 2\n']);
});

test('parseConflicts accepts merge-style conflicts without a base section', () => {
  const segments = parseConflicts('<<<<<<< HEAD\na\n=======\nb\n>>>>>>> x\n');
  assert.deepEqual(segments, [{ type: 'conflict', ours: ['a\n'], base: [], theirs: ['b\n'] }]);
});

test('parseConflicts treats a "=======" line outside a conflict as text', () => {
  const segments = parseConflicts('Title\n=======\n');
  assert.deepEqual(segments, [{ type: 'text', lines: ['Title\n', '=======\n'] }]);
});

test('parseConflicts rejects nested and unterminated markers', () => {
  assert.throws(
    () => parseConflicts('<<<<<<< HEAD\n<<<<<<< HEAD\n=======\n>>>>>>> x\n'),
    (error) => error instanceof ManualReviewError && /nested/.test(error.message)
  );
  assert.throws(
    () => parseConflicts('<<<<<<< HEAD\na\n=======\nb\n'),
    (error) => error instanceof ManualReviewError && /unterminated/.test(error.message)
  );
});

test('renderResolution keeps the chosen side per hunk', () => {
  const segments = parseConflicts(diff3);
  assert.equal(renderResolution(segments, ['theirs', 'ours']), 'top\ntheirs 1\nmiddle\nours 2\nbottom\n');
  assert.equal(renderResolution(segments, ['ours', 'theirs']), 'top\nours 1\nmiddle\nbottom\n');
});

test('pickNewer picks the later timestamp and returns null on a tie', () => {
  assert.equal(pickNewer(200, 100), 'ours');
  assert.equal(pickNewer(100, 200), 'theirs');
  assert.equal(pickNewer(100, 100), null);
});

test('hasConflictMarkers flags leftover markers only at line start', () => {
  assert.equal(hasConflictMarkers('a\n<<<<<<< HEAD\n'), true);
  assert.equal(hasConflictMarkers('a\n=======\nb'), true);
  assert.equal(hasConflictMarkers('a\n>>>>>>> origin/master\n'), true);
  assert.equal(hasConflictMarkers('const s = "<<<<<<< HEAD";\n'), false);
  assert.equal(hasConflictMarkers('========\n'), false);
});

test('locateBlock uses surrounding text to place a repeated hunk', () => {
  const file = splitLines('a\n}\nb\n}\nc\n}\n');
  assert.equal(locateBlock(file, ['}\n']), -1);
  assert.equal(locateBlock(file, ['}\n'], { before: ['b\n'] }), 3);
  assert.equal(locateBlock(file, ['}\n'], { after: ['c\n'] }), 3);
  assert.equal(locateBlock(file, ['}\n'], { from: 4 }), 5);
});

test('locateBlock tolerates a missing newline at end of file', () => {
  const file = splitLines('a\nlast');
  assert.equal(locateBlock(file, ['last\n']), 1);
});
