import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_LEDGER_FILE = path.join(__dirname, '../../data/pr-maint-state.json');

export function emptyState() {
  return { breaker: null, writes: [], repos: {} };
}

export function repoState(state, owner, repo) {
  const key = `${owner}/${repo}`.toLowerCase();
  state.repos[key] = state.repos[key] || {};
  const entry = state.repos[key];
  entry.prs = entry.prs || {};
  entry.escalations = entry.escalations || {};
  entry.dashboard = entry.dashboard || {};
  return entry;
}

// Cache plus budget counters for pr-maint: per-PR fingerprints and written
// hashes, escalation records, the breaker, and recent write times. GitHub stays
// the source of truth: deleting this file costs reads, not duplicate writes.
export class PrMaintLedger {
  constructor({ filePath } = {}) {
    this.filePath = filePath || process.env.SDG_PR_MAINT_STATE_FILE || DEFAULT_LEDGER_FILE;
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyState();
      return { ...emptyState(), ...parsed };
    } catch (_) {
      return emptyState();
    }
  }

  // Temp file + rename so a crash mid-write never leaves a truncated ledger
  save(state) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmpFile = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(state, null, 2));
    fs.renameSync(tmpFile, this.filePath);
  }
}
