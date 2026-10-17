import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseConflicts,
  renderResolution,
  hasConflictMarkers,
  pickNewer,
  locateBlock,
  splitLines,
  isTestFile,
  countTests,
  additionsBySlot,
  unionHunk,
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

test('isTestFile matches test directories and .test/.spec files', () => {
  for (const file of ['test/a.js', 'test/unit/b.txt', '__tests__/c.js', 'src/x.test.js', 'lib/deep/y.spec.js', 'z.test.js']) {
    assert.equal(isTestFile(file), true, file);
  }
  for (const file of ['src/test.js', 'src/test/a.js', 'tests/a.js', 'src/a.js', 'a.test.ts', 'testing/a.js']) {
    assert.equal(isTestFile(file), false, file);
  }
});

test('countTests counts test and it calls at line start, including modifiers', () => {
  const text = [
    "test('a', () => {});\n",
    "  it('b', () => {});\n",
    "test.skip('c', () => {});\n",
    "it.only ('d', () => {});\n",
    "describe('group', () => {});\n",
    "const contest = attest('x');\n"
  ].join('');
  assert.equal(countTests(text), 4);
});

test('unionHunk keeps every added line from both sides, ours before theirs', () => {
  const union = unionHunk({
    base: [],
    ours: ["test('ours 1', () => {});\n", "test('ours 2', () => {});\n"],
    theirs: ["test('theirs 1', () => {});\n"]
  });
  assert.deepEqual(union, [
    "test('ours 1', () => {});\n",
    "test('ours 2', () => {});\n",
    "test('theirs 1', () => {});\n"
  ]);
});

test('unionHunk keeps base lines in place and orders base, ours, theirs per slot', () => {
  const union = unionHunk({
    base: ['b1\n', 'b2\n'],
    ours: ['o0\n', 'b1\n', 'o1\n', 'b2\n'],
    theirs: ['b1\n', 't1\n', 'b2\n', 't2\n']
  });
  assert.deepEqual(union, ['o0\n', 'b1\n', 'o1\n', 't1\n', 'b2\n', 't2\n']);
});

test('unionHunk keeps lines both sides added identically only once', () => {
  assert.deepEqual(unionHunk({ base: [], ours: ['same\n'], theirs: ['same'] }), ['same\n']);
});

test('unionHunk returns null when a side modified or removed a base line', () => {
  assert.equal(unionHunk({ base: ['b\n'], ours: ['b changed\n'], theirs: ['b\n', 't\n'] }), null);
  assert.equal(unionHunk({ base: ['b\n'], ours: ['b\n', 'o\n'], theirs: [] }), null);
  assert.equal(additionsBySlot(['b1\n', 'b2\n'], ['b2\n', 'b1\n']), null);
  assert.deepEqual(additionsBySlot(['b\n'], ['b\n', 'x\n']), [[], ['x\n']]);
});
