import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { readLedgerObject } from './ledger-file.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_LEDGER_FILE = path.join(__dirname, '../../data/pr-maint-state.json');

export function emptyState() {
  return { breaker: null, writes: [], repos: {} };
}

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const objectOr = (value, fallback) => (isPlainObject(value) ? value : fallback);

const finiteList = (value) => (Array.isArray(value) ? value.filter(Number.isFinite) : []);

// Drops per-PR records that are not objects: pr-maint writes fields onto them
// (sticky hash, escalation flags), which throws on a string or number
function keepObjects(records) {
  for (const key of Object.keys(records)) if (!isPlainObject(records[key])) delete records[key];
  return records;
}

export function repoState(state, owner, repo) {
  const key = `${owner}/${repo}`.toLowerCase();
  const entry = state.repos[key] = objectOr(state.repos[key], {});
  entry.prs = keepObjects(objectOr(entry.prs, {}));
  entry.escalations = keepObjects(objectOr(entry.escalations, {}));
  // Escalation history and clears are timestamp lists filtered by age every
  // tick; any other shape would throw there and stall the whole repository
  for (const escalation of Object.values(entry.escalations)) {
    if (escalation.history !== undefined) escalation.history = finiteList(escalation.history);
    if (escalation.clears !== undefined) escalation.clears = finiteList(escalation.clears);
  }
  entry.dashboard = objectOr(entry.dashboard, {});
  return entry;
}

// A field of the wrong shape (hand edit, older schema) falls back to its
// default instead of crashing every tick; the rest of the ledger is kept
function normalize(parsed) {
  const breaker = isPlainObject(parsed.breaker) && Number.isFinite(parsed.breaker.until) ? parsed.breaker : null;
  const writes = Array.isArray(parsed.writes) ? parsed.writes.filter(Number.isFinite) : [];
  return { ...parsed, breaker, writes, repos: objectOr(parsed.repos, {}) };
}

// Cache plus budget counters for pr-maint: per-PR fingerprints and written
// hashes, escalation records, the breaker, and recent write times. GitHub stays
// the source of truth: deleting this file costs reads, not duplicate writes.
export class PrMaintLedger {
  constructor({ filePath } = {}) {
    this.filePath = filePath || process.env.SDG_PR_MAINT_STATE_FILE || DEFAULT_LEDGER_FILE;
  }

  load() {
    const parsed = readLedgerObject(this.filePath, 'pr-maint ledger');
    return parsed ? normalize(parsed) : emptyState();
  }

  // Temp file + rename so a crash mid-write never leaves a truncated ledger.
  // A failed write or rename removes the temp file before rethrowing, so
  // repeated failures do not leave one orphaned file per process in data/.
  save(state) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmpFile = `${this.filePath}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmpFile, JSON.stringify(state, null, 2));
      fs.renameSync(tmpFile, this.filePath);
    } catch (error) {
      try { fs.rmSync(tmpFile, { force: true }); } catch (_) {}
      throw error;
    }
  }
}
