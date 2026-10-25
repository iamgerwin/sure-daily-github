import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_STATE_FILE = path.join(__dirname, '../../data/state.json');

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isCount = (value) => Number.isInteger(value) && value >= 0;

export class StateManager {
  constructor(options = {}) {
    this.filePath = options.filePath || process.env.SDG_STATE_FILE || DEFAULT_STATE_FILE;
    this.state = this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const data = fs.readFileSync(this.filePath, 'utf8');
        const parsed = JSON.parse(data);
        // Valid JSON of the wrong shape is replaced on the next save, so it is
        // backed up like unparseable state. Only a malformed repositories
        // section is reset; the rest (e.g. the round-robin cursor) is kept.
        if (!isPlainObject(parsed)) {
          this.backup('Error loading state, starting fresh: state is not a JSON object');
          return { repositories: {}, meta: { version: 2 } };
        }
        if (!isPlainObject(parsed.repositories)) {
          this.backup('Error loading state, resetting repositories: section is not an object');
          parsed.repositories = {};
        }
        // Attach meta version if missing
        if (!parsed.meta) parsed.meta = { version: 2 };
        return parsed;
      }
    } catch (error) {
      // Graceful fallback: back up corrupted state and reinit
      this.backup(`Error loading state, starting fresh: ${error.message}`);
    }
    return { repositories: {}, meta: { version: 2 } };
  }

  backup(message) {
    try {
      fs.copyFileSync(this.filePath, `${this.filePath}.bak`);
    } catch (_) {}
    console.error(message);
  }

  save() {
    const tmpFile = `${this.filePath}.${process.pid}.tmp`;
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      // Write-then-rename so a crash mid-write cannot leave truncated JSON behind,
      // which load() would treat as corrupt and reset every counter to zero
      fs.writeFileSync(tmpFile, JSON.stringify(this.state, null, 2));
      fs.renameSync(tmpFile, this.filePath);
    } catch (error) {
      try { fs.rmSync(tmpFile, { force: true }); } catch (_) {}
      console.error('Error saving state:', error.message);
    }
  }

  getRepoState(owner, repo) {
    const key = `${owner}/${repo}`;
    // GitHub names are case-insensitive: an entry recorded under other casing is
    // the same repository, so re-casing the config must not reset its counters
    if (!isPlainObject(this.state.repositories[key])) {
      const lower = key.toLowerCase();
      const existing = Object.keys(this.state.repositories)
        .find(k => k.toLowerCase() === lower && isPlainObject(this.state.repositories[k]));
      if (existing) {
        this.state.repositories[key] = this.state.repositories[existing];
        delete this.state.repositories[existing];
      }
    }
    if (!isPlainObject(this.state.repositories[key])) {
      this.state.repositories[key] = {
        // Legacy fields (kept for backward compatibility)
        lastCommitDate: null,
        commitsToday: 0,
        totalCommits: 0,
        // New counters
        counters: {
          hourly: { key: null, count: 0 },
          daily: { key: null, count: 0 },
          weekly: { key: null, count: 0 }
        },
        totals: { issues: 0, commits: 0 }
      };
    }
    return this.state.repositories[key];
  }

  // Compute period keys respecting timezone
  getPeriodKeys(timezone = 'UTC', now = new Date()) {
    // Use Intl to format parts in timezone
    const fmt = (opts) => new Intl.DateTimeFormat('en-CA', { timeZone: timezone, ...opts });
    const parts = Object.fromEntries(fmt({ year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false }).formatToParts(now).map(p => [p.type, p.value]));
    const y = parts.year;
    const m = parts.month;
    const d = parts.day;
    const H = parts.hour;

    // ISO week number
    const tzNowStr = fmt({ year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
    const [yy, mm, dd] = tzNowStr.split('-').map(Number);
    const date = new Date(Date.UTC(yy, mm - 1, dd));
    // Thursday in current week decides the year
    date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
    const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
    const weekKey = `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;

    return {
      hourly: `${y}-${m}-${d}T${H}`,
      daily: `${y}-${m}-${d}`,
      weekly: weekKey
    };
  }

  ensureWindows(owner, repo, timezone = 'UTC', now = new Date()) {
    const repoState = this.getRepoState(owner, repo);
    const keys = this.getPeriodKeys(timezone, now);

    // A window or total of the wrong shape (hand edit, older schema) falls back to
    // a fresh one instead of crashing the run or blocking the repo for good
    const counters = repoState.counters = isPlainObject(repoState.counters) ? repoState.counters : {};
    for (const period of ['hourly', 'daily', 'weekly']) {
      const window = isPlainObject(counters[period]) ? counters[period] : (counters[period] = { key: null, count: 0 });
      if (!isCount(window.count)) window.count = 0;
    }

    if (counters.hourly.key !== keys.hourly) {
      counters.hourly.key = keys.hourly;
      counters.hourly.count = 0;
    }
    if (counters.daily.key !== keys.daily) {
      counters.daily.key = keys.daily;
      counters.daily.count = 0;
      // Maintain legacy daily counter; lastCommitDate only moves when a commit is recorded
      repoState.commitsToday = 0;
    }
    if (counters.weekly.key !== keys.weekly) {
      counters.weekly.key = keys.weekly;
      counters.weekly.count = 0;
    }

    // Ensure totals object
    if (!isPlainObject(repoState.totals)) repoState.totals = { issues: 0, commits: 0 };
    for (const total of ['issues', 'commits']) {
      if (!isCount(repoState.totals[total])) repoState.totals[total] = 0;
    }

    return counters;
  }

  isWithinLimits(owner, repo, limits = {}, timezone = 'UTC', now = new Date()) {
    const counters = this.ensureWindows(owner, repo, timezone, now);

    const hourlyMax = limits.hourlyMax ?? Infinity;
    const dailyMax = limits.dailyMax ?? Infinity;
    const weeklyMax = limits.weeklyMax ?? Infinity;

    const allowed = counters.hourly.count < hourlyMax && counters.daily.count < dailyMax && counters.weekly.count < weeklyMax;

    return {
      allowed,
      counts: {
        hourly: counters.hourly.count,
        daily: counters.daily.count,
        weekly: counters.weekly.count
      },
      limits: { hourlyMax, dailyMax, weeklyMax }
    };
  }

  recordAction(owner, repo, { type = 'issue', timezone = 'UTC', now = new Date() } = {}) {
    const repoState = this.getRepoState(owner, repo);
    const counters = this.ensureWindows(owner, repo, timezone, now);

    counters.hourly.count += 1;
    counters.daily.count += 1;
    counters.weekly.count += 1;

    if (!repoState.totals) repoState.totals = { issues: 0, commits: 0 };
    if (type === 'commit') {
      repoState.totals.commits += 1;
      // Maintain legacy fields for backward compatibility
      repoState.lastCommitDate = counters.daily.key;
      repoState.commitsToday = (repoState.commitsToday || 0) + 1;
      repoState.totalCommits = (repoState.totalCommits || 0) + 1;
    } else {
      repoState.totals.issues += 1;
    }

    this.save();
  }

  getCounts(owner, repo, timezone = 'UTC', now = new Date()) {
    const counters = this.ensureWindows(owner, repo, timezone, now);
    return { hourly: counters.hourly.count, daily: counters.daily.count, weekly: counters.weekly.count };
  }

  // A { min, max } range rolls one target per repository per day, persisted so
  // every run that day (and `status`) agree on it. Changing the range re-rolls.
  getDailyTarget(owner, repo, { min, max }, timezone = 'UTC', now = new Date()) {
    if (min === max) return max;
    const repoState = this.getRepoState(owner, repo);
    const day = this.getPeriodKeys(timezone, now).daily;
    const saved = repoState.dailyTarget;
    if (saved?.day === day && saved.min === min && saved.max === max && Number.isInteger(saved.value)) {
      return saved.value;
    }
    const value = crypto.randomInt(min, max + 1);
    repoState.dailyTarget = { day, min, max, value };
    this.save();
    return value;
  }

  // Round-robin repository selection cursor, persisted so rotation continues across runs
  getRoundRobinIndex() {
    const index = this.state.roundRobin?.index;
    return Number.isInteger(index) && index >= 0 ? index : 0;
  }

  setRoundRobinIndex(index) {
    this.state.roundRobin = { index };
    this.save();
  }

  // Backward compatible methods
  isCommitNeeded(owner, repo, targetCount = 1, timezone = 'UTC', now = new Date()) {
    const { allowed } = this.isWithinLimits(owner, repo, { dailyMax: targetCount }, timezone, now);
    return allowed;
  }

  recordCommit(owner, repo, timezone = 'UTC', now = new Date()) {
    this.recordAction(owner, repo, { type: 'commit', timezone, now });
  }
}

export default new StateManager();
