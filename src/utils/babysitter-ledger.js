import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_LEDGER_FILE = path.join(__dirname, '../../data/babysitter-state.json');

// Terminal states: the comment is never processed again. Its reply may still be
// pending (replyPending), in which case only the delivery is retried.
export const SETTLED_STATES = ['addressed', 'deferred', 'wontfix', 'noted'];
// A fix was pushed but its reply has not been attempted yet (a crash between
// push and reply leaves this); the next run delivers the reply only
export const PUSHED_STATE = 'pushed';
// A failing comment is retried on later runs until it has failed this many times
export const MAX_ATTEMPTS = 2;
// A reply that keeps failing is dropped after this many delivery attempts
export const MAX_DELIVERY_ATTEMPTS = 10;

function emptyLedger() {
  return { version: 1, comments: {}, prs: {}, deliveries: {}, pushIntents: {}, cursor: null };
}

const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);

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
        prs: parsed.prs && typeof parsed.prs === 'object' ? parsed.prs : {},
        deliveries: isObject(parsed.deliveries) ? parsed.deliveries : {},
        pushIntents: isObject(parsed.pushIntents) ? parsed.pushIntents : {},
        cursor: isObject(parsed.cursor) ? parsed.cursor : null
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

  recordOutcome(key, { state, pr, headSha = null, action = null, replyId = null, commitSha = null, reasoning = null, replyPending = false, now = new Date() }, { save = true } = {}) {
    if (!SETTLED_STATES.includes(state) && state !== PUSHED_STATE) {
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
      ...(replyPending ? { replyPending: true } : {}),
      attempts: (previous?.attempts || 0) + 1,
      updatedAt: now.toISOString()
    };
    if (save) this.save();
    return this.data.comments[key];
  }

  // Replies (inline or summary) not yet posted. Each one lists the comment keys
  // it settles and the state each settles to, so it can be retried on its own.
  // One save, which also persists any entries written with { save: false }.
  addDeliveries(deliveries, { now = new Date() } = {}) {
    for (const { id, ...delivery } of deliveries) {
      this.data.deliveries[id] = { attempts: 0, createdAt: now.toISOString(), ...delivery };
      for (const key of delivery.keys) {
        const entry = this.getComment(key);
        if (entry && entry.state !== PUSHED_STATE) entry.replyPending = true;
      }
    }
    this.save();
  }

  getDeliveries() {
    return Object.entries(this.data.deliveries).map(([id, delivery]) => ({ id, ...delivery }));
  }

  completeDelivery(id, replyId, { note = null } = {}) {
    const delivery = this.data.deliveries[id];
    if (!delivery) return;
    for (const key of delivery.keys) {
      const entry = this.getComment(key);
      if (!entry) continue;
      if (entry.state === PUSHED_STATE) entry.state = delivery.states?.[key] || 'addressed';
      delete entry.replyPending;
      if (replyId !== null) entry.replyId = replyId;
      if (note) entry.note = note;
    }
    delete this.data.deliveries[id];
    this.save();
  }

  // A pushed fix whose reply failed is settled as addressed with its reply
  // still pending. Returns the delivery; `exhausted` once it is dropped.
  failDelivery(id, error, { now = new Date() } = {}) {
    const delivery = this.data.deliveries[id];
    if (!delivery) return null;
    delivery.attempts = (delivery.attempts || 0) + 1;
    delivery.error = String(error ?? 'unknown error');
    delivery.updatedAt = now.toISOString();
    for (const key of delivery.keys) {
      const entry = this.getComment(key);
      if (!entry) continue;
      if (entry.state === PUSHED_STATE) entry.state = delivery.states?.[key] || 'addressed';
      entry.replyPending = true;
    }
    const exhausted = delivery.attempts >= MAX_DELIVERY_ATTEMPTS;
    if (exhausted) {
      this.completeDelivery(id, null, { note: `reply abandoned after ${delivery.attempts} attempts: ${delivery.error}` });
    } else {
      this.save();
    }
    return { ...delivery, exhausted };
  }

  // Returns the entry; `exhausted` is true once it will not be retried again
  recordFailure(key, { pr, headSha = null, action = null, error, replyId = null, now = new Date() }, { save = true } = {}) {
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
    if (save) this.save();
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

  // Records that a run was interrupted while handling this PR. Its comments
  // were not charged an attempt, so they are simply picked up again.
  markInterrupted(prKey, { signal = null, now = new Date() } = {}) {
    this.data.prs[prKey] = { ...(this.getPr(prKey) || {}), interrupted: { signal, at: now.toISOString() } };
    this.save();
  }

  // Written before the remote push and removed in the same save that records
  // its outcomes. One left behind means the run died around the push: if the
  // branch head is `expectedSha` the push landed and the stored outcomes are
  // applied, otherwise the comments are simply still pending.
  recordPushIntent(prKey, intent, { now = new Date() } = {}) {
    this.data.pushIntents[prKey] = { ...intent, createdAt: now.toISOString() };
    this.save();
  }

  // The push errored, but the server may have accepted it with only the
  // response lost. The intent stays; `notLanded` holds the outcomes (with the
  // charged failures) to apply if the next run finds the push did not land.
  markPushUnconfirmed(prKey, { error, settled, failures }) {
    const intent = this.data.pushIntents[prKey];
    if (!intent) return;
    intent.notLanded = { error: String(error ?? 'unknown error'), settled, failures };
    this.save();
  }

  getPushIntent(prKey) {
    return this.data.pushIntents[prKey] || null;
  }

  getPushIntents() {
    return Object.entries(this.data.pushIntents).map(([prKey, intent]) => ({ prKey, ...intent }));
  }

  clearPushIntent(prKey, { save = true } = {}) {
    if (!this.data.pushIntents[prKey]) return;
    delete this.data.pushIntents[prKey];
    if (save) this.save();
  }

  // Round-robin position across scans: the last PR visited, as { repo, number }
  getCursor() {
    return this.data.cursor;
  }

  setCursor(cursor) {
    this.data.cursor = cursor;
    this.save();
  }
}
