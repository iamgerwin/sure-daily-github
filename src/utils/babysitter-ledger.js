import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_LEDGER_FILE = path.join(__dirname, '../../data/babysitter-state.json');

// Terminal states: the comment was replied to and is never processed again
export const SETTLED_STATES = ['addressed', 'deferred', 'wontfix', 'noted'];
// A failing comment is retried on later runs until it has failed this many times
export const MAX_ATTEMPTS = 2;

function emptyLedger() {
  return { version: 1, comments: {}, prs: {} };
}

// Per-comment memory for babysit: which review comments were handled, how, and
// with which reply/commit, so a comment is answered exactly once across runs
export class BabysitterLedger {
  constructor(options = {}) {
    this.filePath = options.filePath || process.env.SDG_BABYSITTER_STATE_FILE || DEFAULT_LEDGER_FILE;
    this.data = this.load();
  }

  load() {
    if (!fs.existsSync(this.filePath)) return emptyLedger();
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('ledger is not a JSON object');
      }
      return {
        version: 1,
        comments: parsed.comments && typeof parsed.comments === 'object' ? parsed.comments : {},
        prs: parsed.prs && typeof parsed.prs === 'object' ? parsed.prs : {}
      };
    } catch (error) {
      // Keep the unreadable file for inspection instead of silently losing it
      try { fs.copyFileSync(this.filePath, `${this.filePath}.bak`); } catch (_) {}
      console.error('Error loading babysitter ledger, starting fresh:', error.message);
      return emptyLedger();
    }
  }

  // Write-then-rename so a crash mid-write cannot leave truncated JSON behind.
  // Throws: losing this record would make the next run reply a second time.
  save() {
    const tmpFile = `${this.filePath}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(tmpFile, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmpFile, this.filePath);
    } catch (error) {
      try { fs.rmSync(tmpFile, { force: true }); } catch (_) {}
      throw new Error(`Failed to save babysitter ledger: ${error.message}`);
    }
  }

  static prKey(owner, repo, number) {
    return `${owner}/${repo}#${number}`.toLowerCase();
  }

  // Review comments, reviews, and issue comments use separate id spaces, so the
  // comment id carries its kind (e.g. "review_comment:123")
  static commentKey(owner, repo, number, commentId) {
    return `${BabysitterLedger.prKey(owner, repo, number)}/${commentId}`;
  }

  getComment(key) {
    return this.data.comments[key] || null;
  }

  shouldProcess(key) {
    const entry = this.getComment(key);
    if (!entry) return true;
    return entry.state === 'failed' && (entry.attempts || 0) < MAX_ATTEMPTS;
  }

  recordOutcome(key, { state, pr, headSha = null, action = null, replyId = null, commitSha = null, reasoning = null, now = new Date() }) {
    if (!SETTLED_STATES.includes(state)) {
      throw new Error(`Invalid babysitter ledger state: ${state}`);
    }
    const previous = this.getComment(key);
    this.data.comments[key] = {
      state,
      pr,
      headSha,
      action,
      replyId,
      commitSha,
      reasoning,
      attempts: (previous?.attempts || 0) + 1,
      updatedAt: now.toISOString()
    };
    this.save();
    return this.data.comments[key];
  }

  // Returns the entry; `exhausted` is true once it will not be retried again
  recordFailure(key, { pr, headSha = null, action = null, error, replyId = null, now = new Date() }) {
    const previous = this.getComment(key);
    const attempts = (previous?.attempts || 0) + 1;
    this.data.comments[key] = {
      state: 'failed',
      pr,
      headSha,
      action,
      replyId: replyId ?? previous?.replyId ?? null,
      commitSha: null,
      error: String(error ?? 'unknown error'),
      attempts,
      updatedAt: now.toISOString()
    };
    this.save();
    return { ...this.data.comments[key], exhausted: attempts >= MAX_ATTEMPTS };
  }

  // Records the reply posted when a failure is given up on
  setReplyId(key, replyId) {
    const entry = this.getComment(key);
    if (!entry) return;
    entry.replyId = replyId;
    this.save();
  }

  getPr(prKey) {
    return this.data.prs[prKey] || null;
  }

  markForkNotified(prKey, { replyId = null, now = new Date() } = {}) {
    this.data.prs[prKey] = { ...(this.getPr(prKey) || {}), forkNotice: { replyId, at: now.toISOString() } };
    this.save();
  }
}
