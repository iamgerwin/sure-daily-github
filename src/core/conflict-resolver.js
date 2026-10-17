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

// Raised for anything the newer-wins rule must not guess at; the PR is then
// left for a human instead of being pushed
export class ManualReviewError extends Error {}

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

export function renderResolution(segments, winners) {
  let conflictIndex = 0;
  return segments
    .map(segment => (segment.type === 'text'
      ? segment.lines
      : segment[winners[conflictIndex++]]).join(''))
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

async function resolveFile(git, cwd, file, info, mergeBase) {
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
  const sides = {
    ours: { rev: 'HEAD', lines: splitLines(ours), cursor: 0 },
    theirs: { rev: 'MERGE_HEAD', lines: splitLines(theirs), cursor: 0 }
  };
  const winners = [];

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (segment.type !== 'conflict') continue;

    const before = segments[i - 1]?.type === 'text' ? segments[i - 1].lines.slice(-CONTEXT_LINES) : [];
    const after = segments[i + 1]?.type === 'text' ? segments[i + 1].lines.slice(0, CONTEXT_LINES) : [];
    const times = {};

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
      times[name] = await blameTime(git, side.rev, file, index, block.length);
    }

    const winner = pickNewer(times.ours, times.theirs);
    if (!winner) {
      throw new ManualReviewError(`${file}: conflict hunk ${winners.length + 1} changed at the same time on both sides`);
    }
    winners.push(winner);
  }

  if (winners.length === 0) {
    throw new ManualReviewError(`${file}: unmerged without conflict markers`);
  }

  const resolved = renderResolution(segments, winners);
  if (hasConflictMarkers(resolved)) {
    throw new ManualReviewError(`${file}: conflict markers left after resolution`);
  }
  fs.writeFileSync(path.join(cwd, file), resolved, 'latin1');
  await mustGit(git, ['add', '--', file]);
  return { file, hunks: winners };
}

// Resolves an in-progress diff3 merge in `cwd` by keeping, per conflicting hunk,
// the side whose lines were committed most recently. Returns
// { resolved: true, files } or { resolved: false, reason } without touching
// anything the rule cannot decide on its own.
export async function resolveConflicts({ cwd, git = (args, options) => runGit(args, { cwd, ...options }) }) {
  try {
    const unmerged = parseUnmerged(await mustGit(git, ['ls-files', '-u', '-z']));
    if (unmerged.size === 0) {
      throw new ManualReviewError('merge stopped without unmerged files');
    }
    const mergeBase = (await mustGit(git, ['merge-base', 'HEAD', 'MERGE_HEAD'])).trim();

    const files = [];
    for (const [file, info] of unmerged) {
      files.push(await resolveFile(git, cwd, file, info, mergeBase));
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
      return { resolved: false, reason: error.message };
    }
    throw error;
  }
}
