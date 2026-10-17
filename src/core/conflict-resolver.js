import fs from 'fs';
import path from 'path';
import { runGit } from '../utils/git.js';

// Lines keep their terminators; markers may carry a label ("<<<<<<< HEAD")
const START = /^<{7}(?: |\r?\n?$)/;
const BASE = /^\|{7}(?: |\r?\n?$)/;
const SEPARATOR = /^={7}\r?\n?$/;
const END = /^>{7}(?: |\r?\n?$)/;
const LEFTOVER_MARKER = /^(<{7}|\|{7}|={7}|>{7})( |\r?$)/m;
// Lines of surrounding text used to pin a hunk down when its own text repeats
const CONTEXT_LINES = 3;
// Same window git uses to decide whether a blob is binary
const BINARY_SNIFF_CHARS = 8000;
// Conflicts in these files keep both sides instead of the newer one, so tests
// added on the older side are never dropped
const TEST_FILE_PATTERNS = [/^test\//, /^__tests__\//, /\.test\.js$/, /\.spec\.js$/];
// A test(...) or it(...) registration at the start of a line: optionally
// awaited, optionally on a receiver (t.test, suite.it), including .only/.skip/.todo
const TEST_CALL = /^[ \t]*(?:await[ \t]+)?(?:[A-Za-z_$][\w$]*\.)?(?:test|it)(?:\.(?:only|skip|todo))?[ \t]*\(/gm;
// Any test(...) or it(...) call, wherever it sits; seeing one when TEST_CALL
// counts nothing means the file registers tests in a form we cannot count
const ANY_TEST_CALL = /\b(?:test|it)\b(?:\.\w+)*[ \t]*\(/;
export const SOURCE_HUNK_STRATEGIES = ['push', 'claude', 'escalate'];

// Raised for anything the newer-wins rule must not guess at; the PR is then
// left for a human instead of being pushed. `file` names the path to escalate.
export class ManualReviewError extends Error {
  constructor(message, { file } = {}) {
    super(message);
    this.file = file;
  }
}

export function splitLines(text) {
  return text === '' ? [] : text.split(/(?<=\n)/);
}

// Parses a file written with merge.conflictStyle=diff3 into plain text and
// conflict segments ({ ours, base, theirs } line arrays)
export function parseConflicts(text) {
  const segments = [];
  let plain = [];
  let current = null;
  let section = null;

  for (const line of splitLines(text)) {
    if (!current) {
      if (START.test(line)) {
        if (plain.length) segments.push({ type: 'text', lines: plain });
        plain = [];
        current = { type: 'conflict', ours: [], base: [], theirs: [] };
        section = 'ours';
      } else {
        plain.push(line);
      }
      continue;
    }

    if (START.test(line)) {
      throw new ManualReviewError('nested conflict markers');
    }
    if (section === 'ours' && BASE.test(line)) {
      section = 'base';
    } else if (section !== 'theirs' && SEPARATOR.test(line)) {
      section = 'theirs';
    } else if (section === 'theirs' && END.test(line)) {
      segments.push(current);
      current = null;
    } else {
      current[section].push(line);
    }
  }

  if (current) {
    throw new ManualReviewError('unterminated conflict marker');
  }
  if (plain.length) segments.push({ type: 'text', lines: plain });
  return segments;
}

// `kept` optionally gives, per conflict, the winning side's lines as stored in
// its blob. Prefer it: the parsed lines carry the newline git adds before a
// marker even when the side's last line has none.
export function renderResolution(segments, winners, kept = []) {
  let conflictIndex = 0;
  return segments
    .map(segment => {
      if (segment.type === 'text') return segment.lines.join('');
      const index = conflictIndex++;
      return (kept[index] ?? segment[winners[index]]).join('');
    })
    .join('');
}

export function hasConflictMarkers(text) {
  return LEFTOVER_MARKER.test(text);
}

// 'ours' | 'theirs' for the side whose change is newer, null on a tie
export function pickNewer(oursTime, theirsTime) {
  if (oursTime === theirsTime) return null;
  return oursTime > theirsTime ? 'ours' : 'theirs';
}

// A file's last line may lack the newline git adds before the next marker
const normalize = (line) => line.replace(/\r?\n$/, '');
const sameLines = (a, b) => a.length === b.length && a.every((line, i) => normalize(line) === normalize(b[i]));

export function isTestFile(file) {
  return TEST_FILE_PATTERNS.some(pattern => pattern.test(file));
}

const blankOut = (text) => text.replace(/[^\n]/g, ' ');

// `text` with comments, '...'/"..." strings and the literal text of `...`
// templates blanked out (newlines kept), so a test( mentioned there is inert
// and not mistaken for a registration. ${...} inside a template is code and is
// kept. An unclosed comment, string or template stops the stripping, so a
// misread keeps the text and fails closed.
function stripCommentsAndStrings(text) {
  let out = '';
  // Brace depth inside each open ${...}, innermost last
  const interpolations = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '/' && next === '/') {
      const newline = text.indexOf('\n', i);
      const end = newline === -1 ? text.length : newline;
      out += blankOut(text.slice(i, end));
      i = end;
    } else if (ch === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) return out + text.slice(i);
      out += blankOut(text.slice(i, end + 2));
      i = end + 2;
    } else if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== ch && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      if (j >= text.length || text[j] !== ch) return out + text.slice(i);
      out += blankOut(text.slice(i, j + 1));
      i = j + 1;
    } else if (ch === '`' || (ch === '}' && interpolations.at(-1) === 0)) {
      // Opening a template, or closing a ${...} and resuming its template
      if (ch === '}') interpolations.pop();
      let j = i + 1;
      while (j < text.length && text[j] !== '`' && !(text[j] === '$' && text[j + 1] === '{')) {
        j += text[j] === '\\' ? 2 : 1;
      }
      if (j >= text.length) return out + text.slice(i);
      if (text[j] === '`') {
        out += blankOut(text.slice(i, j + 1));
        i = j + 1;
      } else {
        out += blankOut(text.slice(i, j + 2));
        interpolations.push(0);
        i = j + 2;
      }
    } else {
      if (interpolations.length && ch === '{') interpolations[interpolations.length - 1]++;
      if (interpolations.length && ch === '}') interpolations[interpolations.length - 1]--;
      out += ch;
      i++;
    }
  }
  return out;
}

// Number of test registrations in `text`, or null when it cannot be told
export function countTests(text) {
  const count = (text.match(TEST_CALL) || []).length;
  return count === 0 && ANY_TEST_CALL.test(stripCommentsAndStrings(text)) ? null : count;
}

const indentOf = (line) => /^[ \t]*/.exec(line)[0].length;
const isBlank = (line) => normalize(line).trim() === '';

// Unescaped backticks on a line; an odd count opens or closes a template literal
const backticks = (line) => (line.match(/(?<!\\)(?:\\\\)*`/g) || []).length;

// Compared form of a block: blank lines at its edges are separator artifacts,
// blank lines inside it (a template literal fixture, say) are content
function blockKey(block) {
  let start = 0;
  let end = block.length;
  while (start < end && isBlank(block[start])) start++;
  while (end > start && isBlank(block[end - 1])) end--;
  return block.slice(start, end).map(normalize).join('\n');
}

// Splits added lines into top-level blocks (a whole test(...) call with its
// body and closing line). A block starts at a least-indented line that does not
// close a bracket and is not inside a template literal, and takes the blank
// lines just before it.
function splitBlocks(lines) {
  const filled = lines.filter(line => !isBlank(line));
  const minIndent = Math.min(...filled.map(indentOf));
  const blocks = [];
  let blanks = [];
  let inTemplate = false;
  for (const line of lines) {
    if (isBlank(line) && !inTemplate) {
      blanks.push(line);
      continue;
    }
    if (blocks.length === 0 || (!inTemplate && indentOf(line) === minIndent && !/^[ \t]*[)\]}]/.test(line))) {
      blocks.push([...blanks, line]);
    } else {
      blocks[blocks.length - 1].push(...blanks, line);
    }
    blanks = [];
    if (backticks(line) % 2 === 1) inTemplate = !inTemplate;
  }
  if (blanks.length) {
    if (blocks.length) blocks[blocks.length - 1].push(...blanks);
    else blocks.push(blanks);
  }
  return blocks.map(block => ({ lines: block, key: blockKey(block) }));
}

// Merges two sides' additions to one slot: blocks both sides added identically
// appear once (ours' copy), everything else is kept with ours before theirs
// between shared blocks. Throws when the shared blocks cannot be lined up.
function mergeSlot(ours, theirs) {
  if (sameLines(ours, theirs)) return [...ours];
  if (ours.length === 0 || theirs.length === 0) return [...ours, ...theirs];

  const oursBlocks = splitBlocks(ours);
  const theirsBlocks = splitBlocks(theirs);
  const tally = (blocks, key) => blocks.filter(block => block.key === key).length;
  const shared = oursBlocks.filter(block => block.key !== '' && tally(theirsBlocks, block.key) > 0).map(block => block.key);
  for (const key of shared) {
    if (tally(oursBlocks, key) !== 1 || tally(theirsBlocks, key) !== 1) {
      throw new ManualReviewError('shared addition repeats on one side, cannot line it up');
    }
  }
  const theirsShared = theirsBlocks.filter(block => shared.includes(block.key)).map(block => block.key);
  if (theirsShared.some((key, i) => key !== shared[i])) {
    throw new ManualReviewError('shared additions appear in a different order on each side');
  }

  const lines = [];
  let t = 0;
  for (const block of oursBlocks) {
    if (shared.includes(block.key)) {
      while (theirsBlocks[t].key !== block.key) lines.push(...theirsBlocks[t++].lines);
      t++;
    }
    lines.push(...block.lines);
  }
  while (t < theirsBlocks.length) lines.push(...theirsBlocks[t++].lines);
  return lines;
}

// The lines `side` inserted around the base lines, grouped by slot (slot i sits
// just before base line i), or null when the side changed or removed a base line
export function additionsBySlot(base, side) {
  const slots = Array.from({ length: base.length + 1 }, () => []);
  let next = 0;
  for (const line of side) {
    if (next < base.length && normalize(line) === normalize(base[next])) {
      next++;
    } else {
      slots[next].push(line);
    }
  }
  return next === base.length ? slots : null;
}

// Union of a purely additive hunk: the base lines stay in place and each slot
// gets ours' additions, then theirs' (blocks both added identically only once).
// Returns null when either side modified a base line; throws ManualReviewError
// when shared additions cannot be lined up.
export function unionHunk({ base, ours, theirs }) {
  const oursSlots = additionsBySlot(base, ours);
  const theirsSlots = additionsBySlot(base, theirs);
  if (!oursSlots || !theirsSlots) return null;

  const lines = [];
  for (let i = 0; i <= base.length; i++) {
    lines.push(...mergeSlot(oursSlots[i], theirsSlots[i]));
    if (i < base.length) lines.push(base[i]);
  }
  return lines;
}

function findAll(haystack, needle, from) {
  const hits = [];
  for (let i = from; i + needle.length <= haystack.length && hits.length < 2; i++) {
    if (needle.every((line, j) => haystack[i + j] === line)) hits.push(i);
  }
  return hits;
}

// Index of `block` in `fileLines` at or after `from`, or -1 if it cannot be
// placed unambiguously. Surrounding text is tried first because short hunks
// (a lone "}") usually repeat throughout a file.
export function locateBlock(fileLines, block, { before = [], after = [], from = 0 } = {}) {
  const hay = fileLines.map(normalize);
  const needle = block.map(normalize);

  if (before.length || after.length) {
    const context = [...before.map(normalize), ...needle, ...after.map(normalize)];
    const hits = findAll(hay, context, Math.max(from - before.length, 0));
    if (hits.length === 1) return hits[0] + before.length;
  }

  const hits = findAll(hay, needle, from);
  return hits.length === 1 ? hits[0] : -1;
}

async function mustGit(git, args, options) {
  const result = await git(args, options);
  if (result.code !== 0) {
    throw new ManualReviewError(`git ${args[0]} failed: ${String(result.stderr).trim()}`);
  }
  return result.stdout;
}

// Newest committer time among the commits that last touched the given lines
async function blameTime(git, rev, file, start, count) {
  const out = await mustGit(git, ['blame', '--porcelain', '-L', `${start + 1},${start + count}`, rev, '--', file]);
  let newest = 0;
  for (const match of out.matchAll(/^committer-time (\d+)$/gm)) {
    newest = Math.max(newest, Number(match[1]));
  }
  return newest;
}

// A side that deleted the hunk has no lines to blame, so fall back to its
// newest commit touching the file since the merge base
async function fileTime(git, mergeBase, rev, file) {
  const out = await mustGit(git, ['log', '-1', '--format=%ct', `${mergeBase}..${rev}`, '--', file]);
  return Number(out.trim()) || 0;
}

function parseUnmerged(out) {
  const files = new Map();
  for (const entry of out.split('\0').filter(Boolean)) {
    const match = /^(\d+) [0-9a-f]+ (\d)\t(.*)$/s.exec(entry);
    if (!match) continue;
    const [, mode, stage, file] = match;
    if (!files.has(file)) files.set(file, { stages: new Set(), modes: new Set() });
    files.get(file).stages.add(stage);
    files.get(file).modes.add(mode);
  }
  return files;
}

async function resolveFile(git, cwd, file, info, mergeBase, sourceHunks) {
  if (!info.stages.has('2') || !info.stages.has('3')) {
    throw new ManualReviewError(`${file}: deleted on one side (stages ${[...info.stages].join(',')})`);
  }
  if (info.modes.has('160000')) throw new ManualReviewError(`${file}: submodule conflict`);
  if (info.modes.has('120000')) throw new ManualReviewError(`${file}: symlink conflict`);

  // latin1 maps bytes 1:1, so non-UTF-8 text survives the round trip untouched
  const blob = (stage) => mustGit(git, ['cat-file', 'blob', `:${stage}:${file}`], { encoding: 'latin1' });
  const ours = await blob(2);
  const theirs = await blob(3);
  const working = fs.readFileSync(path.join(cwd, file), 'latin1');
  if ([ours, theirs, working].some(text => text.slice(0, BINARY_SNIFF_CHARS).includes('\0'))) {
    throw new ManualReviewError(`${file}: binary conflict`);
  }

  const segments = parseConflicts(working);
  const testFile = isTestFile(file);
  if (!testFile && sourceHunks !== 'push') {
    throw new ManualReviewError(`${file}: source conflict left for review (sourceHunks: ${sourceHunks})`, { file });
  }
  const sides = {
    ours: { rev: 'HEAD', lines: splitLines(ours), cursor: 0 },
    theirs: { rev: 'MERGE_HEAD', lines: splitLines(theirs), cursor: 0 }
  };
  const winners = [];
  const kept = [];

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (segment.type !== 'conflict') continue;

    if (testFile) {
      let union;
      try {
        union = unionHunk(segment);
      } catch (error) {
        if (!(error instanceof ManualReviewError)) throw error;
        throw new ManualReviewError(`${file}: test hunk ${winners.length + 1}: ${error.message}`, { file });
      }
      if (!union) {
        const modified = ['ours', 'theirs'].filter(name => !additionsBySlot(segment.base, segment[name]));
        throw new ManualReviewError(
          `${file}: test hunk ${winners.length + 1} modifies existing lines (${modified.join(', ')}), not only adds`,
          { file }
        );
      }
      // Drop the newline git adds before the closing marker when neither side
      // ends the file with one
      if (i === segments.length - 1 && union.length && !ours.endsWith('\n') && !theirs.endsWith('\n')) {
        union[union.length - 1] = normalize(union[union.length - 1]);
      }
      winners.push('union');
      kept.push(union);
      continue;
    }

    const before = segments[i - 1]?.type === 'text' ? segments[i - 1].lines.slice(-CONTEXT_LINES) : [];
    const after = segments[i + 1]?.type === 'text' ? segments[i + 1].lines.slice(0, CONTEXT_LINES) : [];
    const times = {};
    const originals = { ours: [], theirs: [] };

    for (const [name, side] of Object.entries(sides)) {
      const block = segment[name];
      if (block.length === 0) {
        times[name] = await fileTime(git, mergeBase, side.rev, file);
        continue;
      }
      const index = locateBlock(side.lines, block, { before, after, from: side.cursor });
      if (index === -1) {
        throw new ManualReviewError(`${file}: could not locate conflict hunk ${winners.length + 1} (${name})`);
      }
      side.cursor = index + block.length;
      originals[name] = side.lines.slice(index, index + block.length);
      times[name] = await blameTime(git, side.rev, file, index, block.length);
    }

    const winner = pickNewer(times.ours, times.theirs);
    if (!winner) {
      throw new ManualReviewError(`${file}: conflict hunk ${winners.length + 1} changed at the same time on both sides`);
    }
    winners.push(winner);
    kept.push(originals[winner]);
  }

  if (winners.length === 0) {
    throw new ManualReviewError(`${file}: unmerged without conflict markers`);
  }

  const resolved = renderResolution(segments, winners, kept);
  if (hasConflictMarkers(resolved)) {
    throw new ManualReviewError(`${file}: conflict markers left after resolution`);
  }
  // Safety net for the union: the merged file must keep at least as many tests
  // as either parent. Fails, for example, when one side cleanly deleted tests.
  // A count we cannot establish fails closed.
  if (testFile) {
    const counts = [ours, theirs, resolved].map(countTests);
    if (counts.includes(null)) {
      throw new ManualReviewError(`${file}: could not count tests reliably, left for review`, { file });
    }
    const [floor, remaining] = [Math.max(counts[0], counts[1]), counts[2]];
    if (remaining < floor) {
      throw new ManualReviewError(`${file}: resolution keeps ${remaining} tests, fewer than the ${floor} on one side`, { file });
    }
  }
  fs.writeFileSync(path.join(cwd, file), resolved, 'latin1');
  await mustGit(git, ['add', '--', file]);
  return { file, hunks: winners };
}

// Resolves an in-progress diff3 merge in `cwd` by keeping, per conflicting hunk,
// the side whose lines were committed most recently; test files keep both
// sides instead. With sourceHunks other than 'push', any conflict outside a
// test file is left for review. Returns { resolved: true, files } or
// { resolved: false, reason[, file] } without touching anything the rules
// cannot decide on their own.
export async function resolveConflicts({
  cwd,
  git = (args, options) => runGit(args, { cwd, ...options }),
  sourceHunks = 'push'
}) {
  try {
    const unmerged = parseUnmerged(await mustGit(git, ['ls-files', '-u', '-z']));
    if (unmerged.size === 0) {
      throw new ManualReviewError('merge stopped without unmerged files');
    }
    const mergeBase = (await mustGit(git, ['merge-base', 'HEAD', 'MERGE_HEAD'])).trim();

    const files = [];
    for (const [file, info] of unmerged) {
      files.push(await resolveFile(git, cwd, file, info, mergeBase, sourceHunks));
    }

    if ((await mustGit(git, ['ls-files', '-u', '-z'])) !== '') {
      throw new ManualReviewError('unmerged files remain after resolution');
    }
    // Whitespace rules are switched off so only leftover conflict markers fail
    const check = await git([
      '-c', 'core.whitespace=-blank-at-eol,-blank-at-eof,-space-before-tab,-indent-with-non-tab,-tab-in-indent,-cr-at-eol',
      'diff', '--cached', '--check', '--', ...files.map(f => f.file)
    ]);
    if (check.code !== 0) {
      throw new ManualReviewError(`conflict markers left after resolution: ${String(check.stdout).trim()}`);
    }

    return { resolved: true, files };
  } catch (error) {
    if (error instanceof ManualReviewError) {
      return { resolved: false, reason: error.message, ...(error.file && { file: error.file }) };
    }
    throw error;
  }
}
