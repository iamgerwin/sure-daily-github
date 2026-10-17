import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_LEDGER_FILE = path.join(__dirname, '../../data/conflict-fixer-state.json');

const FINISHED_STATUSES = new Set(['fixed', 'needs-manual-review', 'failed']);

// Fixer outcomes that count as an attempt on this head SHA; anything else
// (stale status, moved head, dry run) leaves no entry behind
const LEDGER_STATUS = {
  fixed: 'fixed',
  'needs-manual-review': 'needs-manual-review',
  error: 'failed'
};

export function ledgerKey(owner, repo, number) {
  return `${owner}/${repo}#${number}`;
}

// Records per-PR fix attempts keyed by head SHA so overlapping or repeated
// runs do not clone and test the same commit again
export class FixerLedger {
  constructor({ filePath } = {}) {
    this.filePath = filePath || process.env.SDG_CONFLICT_FIXER_STATE_FILE || DEFAULT_LEDGER_FILE;
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  // Temp file + rename so a crash mid-write never leaves a truncated ledger
  save(entries) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmpFile = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(entries, null, 2));
    fs.renameSync(tmpFile, this.filePath);
  }

  update(mutate) {
    const entries = this.load();
    mutate(entries);
    this.save(entries);
  }

  // Returns a skip reason, or null when the PR is eligible
  skipReason(key, headSha, { now = Date.now(), attemptTtlMs, retryCooldownMs }) {
    const entry = this.load()[key];
    if (!entry || entry.headSha !== headSha) return null;
    if (entry.status === 'in-progress' && now - entry.startedAt < attemptTtlMs) {
      return 'already-in-progress';
    }
    if (FINISHED_STATUSES.has(entry.status) && now - entry.finishedAt < retryCooldownMs) {
      return 'already-attempted';
    }
    return null;
  }

  start(key, headSha, now = Date.now()) {
    this.update(entries => {
      entries[key] = { headSha, status: 'in-progress', startedAt: now, finishedAt: null };
    });
  }

  finish(key, fixerStatus, now = Date.now()) {
    this.update(entries => {
      const status = LEDGER_STATUS[fixerStatus];
      if (!status) {
        delete entries[key];
      } else if (entries[key]) {
        entries[key] = { ...entries[key], status, finishedAt: now };
      }
    });
  }

  markInterrupted(keys, now = Date.now()) {
    this.update(entries => {
      for (const key of keys) {
        if (entries[key]?.status === 'in-progress') {
          entries[key] = { ...entries[key], status: 'interrupted', finishedAt: now };
        }
      }
    });
  }
}
