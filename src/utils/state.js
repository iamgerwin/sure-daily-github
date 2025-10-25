import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_STATE_FILE = path.join(__dirname, '../../data/state.json');

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
        // Ensure base structure
        if (!parsed || typeof parsed !== 'object' || !parsed.repositories) {
          return { repositories: {}, meta: { version: 2 } };
        }
        // Attach meta version if missing
        if (!parsed.meta) parsed.meta = { version: 2 };
        return parsed;
      }
    } catch (error) {
      // Graceful fallback: back up corrupted state and reinit
      try {
        const backup = `${this.filePath}.bak`;
        fs.copyFileSync(this.filePath, backup);
      } catch (_) {}
      console.error('Error loading state, starting fresh:', error.message);
    }
    return { repositories: {}, meta: { version: 2 } };
  }

  save() {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
    } catch (error) {
      console.error('Error saving state:', error.message);
    }
  }

  getRepoState(owner, repo) {
    const key = `${owner}/${repo}`;
    if (!this.state.repositories[key]) {
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

    const counters = repoState.counters || (repoState.counters = { hourly: { key: null, count: 0 }, daily: { key: null, count: 0 }, weekly: { key: null, count: 0 } });

    if (counters.hourly.key !== keys.hourly) {
      counters.hourly.key = keys.hourly;
      counters.hourly.count = 0;
    }
    if (counters.daily.key !== keys.daily) {
      counters.daily.key = keys.daily;
      counters.daily.count = 0;
      // Maintain legacy daily fields
      repoState.lastCommitDate = keys.daily;
      repoState.commitsToday = 0;
    }
    if (counters.weekly.key !== keys.weekly) {
      counters.weekly.key = keys.weekly;
      counters.weekly.count = 0;
    }

    // Ensure totals object
    if (!repoState.totals) repoState.totals = { issues: 0, commits: 0 };

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
