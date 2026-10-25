import { createOctokit } from './octokit.js';
import logger from '../utils/logger.js';
import randomizer from '../utils/randomizer.js';
import stateManager from '../utils/state.js';
import { getTemplateDateParts } from '../utils/template-date.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Anchored to the project root (like StateManager) so it does not depend on cwd
const DEFAULT_STATE_FILE = path.join(__dirname, '../../data/issue-state.json');

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isCount = (value) => Number.isInteger(value) && value >= 0;

class AdvancedIssueHandler {
  constructor(token) {
    this.token = token;
    this.client = null;
    this.stateFile = process.env.SDG_ISSUE_STATE_FILE || DEFAULT_STATE_FILE;
    // Persists the round-robin cursor shared with the simple issue handler
    this.cursorStore = stateManager;
  }

  async init() {
    try {
      this.client = createOctokit({ auth: this.token });
      const { data: user } = await this.client.users.getAuthenticated();
      return { success: true, user: user.login };
    } catch (error) {
      logger.error('GitHub authentication failed', { error: error.message });
      return { success: false, error: error.message };
    }
  }

  async loadState() {
    try {
      const data = await fs.readFile(this.stateFile, 'utf-8');
      const parsed = JSON.parse(data);
      if (!isPlainObject(parsed)) throw new Error('issue state is not a JSON object');
      // An array would drop every repo entry on save (so the daily target is
      // never reached) and a string or number would crash the run
      if (!isPlainObject(parsed.repositories)) parsed.repositories = {};
      return parsed;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        // Keep the unreadable file for inspection instead of silently discarding progress
        const backup = `${this.stateFile}.corrupt-${Date.now()}`;
        await fs.copyFile(this.stateFile, backup).catch(() => {});
        logger.error('Failed to load issue state, starting fresh', { error: error.message, backup });
      }
      // Initialize default state
      return {
        lastDailyReset: null,
        repositories: {}
      };
    }
  }

  // Throws on failure: if progress cannot be persisted, creating more issues
  // would ignore the daily target on every subsequent run
  async saveState(state) {
    const tmpFile = `${this.stateFile}.${process.pid}.tmp`;
    try {
      await fs.mkdir(path.dirname(this.stateFile), { recursive: true });
      // Write-then-rename so a crash mid-write cannot leave truncated JSON behind
      await fs.writeFile(tmpFile, JSON.stringify(state, null, 2));
      await fs.rename(tmpFile, this.stateFile);
    } catch (error) {
      await fs.rm(tmpFile, { force: true }).catch(() => {});
      logger.error('Failed to save state', { error: error.message });
      throw error;
    }
  }

  getRepoKey(repo) {
    return `${repo.owner}/${repo.repo}`;
  }

  // Older state files keyed repositories by name only; adopt that entry if present
  getRepoState(state, repo) {
    const key = this.getRepoKey(repo);
    if (!state.repositories[key] && state.repositories[repo.repo]) {
      state.repositories[key] = state.repositories[repo.repo];
      delete state.repositories[repo.repo];
    }
    return state.repositories[key];
  }

  shouldResetDaily(state, timezone) {
    if (!state.lastDailyReset) return true;
    
    const now = new Date();
    const lastReset = new Date(state.lastDailyReset);
    
    // Check if we've crossed midnight in the specified timezone
    const nowDate = this.getDateInTimezone(now, timezone);
    const lastResetDate = this.getDateInTimezone(lastReset, timezone);
    
    return nowDate !== lastResetDate;
  }

  getDateInTimezone(date, timezone) {
    return new Date(date.toLocaleString('en-US', { timeZone: timezone })).toDateString();
  }

  getRandomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  // Keeps today's rolled target while the configured range is unchanged, so an
  // edited dailyTarget takes effect the same day instead of tomorrow (matching
  // commit mode). Returns true when a new target was rolled.
  resolveTodayTarget(repoState, dailyTarget) {
    const { min, max } = typeof dailyTarget === 'object' ? dailyTarget : { min: dailyTarget, max: dailyTarget };
    const target = repoState.todayTarget;
    const saved = repoState.targetRange;
    // State written before targetRange was recorded keeps its target if it still fits the range
    const sameRange = saved
      ? saved.min === min && saved.max === max
      : target >= min && target <= max;
    if (Number.isInteger(target) && sameRange) {
      if (!saved) repoState.targetRange = { min, max };
      return false;
    }
    repoState.todayTarget = this.getRandomInt(min, max);
    repoState.targetRange = { min, max };
    return true;
  }

  getRandomElement(array) {
    if (!array || array.length === 0) return null;
    return array[Math.floor(Math.random() * array.length)];
  }

  generateIssueContent(repo, config, now = new Date()) {
    const randomization = config.randomization || {};
    const templates = config.contentTemplates || [];
    
    // Pick a random template or use default
    const template = templates.length > 0 ? this.getRandomElement(templates) : {};
    // ${date} and ${time} follow general.timezone, not the host's locale and clock
    const { date, time, timestamp } = getTemplateDateParts(config.general?.timezone || 'UTC', now);
    
    // Replace placeholders
    const replacements = {
      repo: repo.repo,
      timestamp,
      randomBugTitle: randomization.bugTitles ? this.getRandomElement(randomization.bugTitles) : 'General bug',
      randomFeatureTitle: randomization.featureTitles ? this.getRandomElement(randomization.featureTitles) : 'General feature',
      randomDocTitle: randomization.docTitles ? this.getRandomElement(randomization.docTitles) : 'General documentation',
      randomPerfTitle: randomization.perfTitles ? this.getRandomElement(randomization.perfTitles) : 'General performance',
      randomBugDescription: 'Issue detected in the system that needs attention',
      randomFeatureDescription: 'New functionality that would improve user experience',
      step1: 'Navigate to the relevant section',
      step2: 'Perform the action',
      step3: 'Observe the result',
      expectedBehavior: 'System should work as intended',
      actualBehavior: 'System behavior differs from expected',
      useCase: 'Improve workflow efficiency',
      proposedSolution: 'Implement the feature as described',
      alternatives: 'Alternative approaches were considered',
      priority: this.getRandomElement(['Low', 'Medium', 'High']),
      section: 'General documentation',
      currentState: 'Current documentation state',
      proposedChanges: 'Proposed documentation improvements',
      reason: 'To improve clarity and usability',
      area: 'System performance',
      currentPerf: 'Current performance metrics',
      targetPerf: 'Target performance goals',
      approach: 'Optimization strategy',
      date,
      time
    };
    
    // Generate title
    let title = template.title || `Automated Issue - ${replacements.date} ${replacements.time}`;
    let body = template.body || `# Automated Issue\n\n**Created:** ${timestamp}\n**Repository:** ${repo.repo}\n\n---\n*Automated issue created by sure-daily-github*`;
    
    // One pass with a replacer function: values are inserted literally, so a
    // configured title containing `$&`, `$'` or `$$` (string replacement
    // patterns) or a `${...}` placeholder is not rewritten. Unknown
    // placeholders are left as written.
    const fill = text => text.replace(/\$\{(\w+)\}/g, (match, key) =>
      Object.hasOwn(replacements, key) ? String(replacements[key]) : match);
    title = fill(title);
    body = fill(body);
    
    return {
      title,
      body,
      labels: [...(template.labels || []), ...(repo.labels || [])]
    };
  }

  async processRepositories(repositories, contentTemplate, dryRun, fullConfig) {
    const state = await this.loadState();
    const timezone = fullConfig.general?.timezone || 'UTC';
    
    // Check if we need to reset daily counters
    if (this.shouldResetDaily(state, timezone)) {
      logger.info('Performing daily reset', { timezone });
      state.lastDailyReset = new Date().toISOString();
      state.repositories = {};
    }
    
    // Results use the same { owner, repo } shape as the other handlers so the
    // CLI failure summary can name the repository
    const results = [];
    const now = Date.now();
    const ready = [];

    for (const repo of repositories) {
      if (!repo.enabled) {
        results.push({
          success: true,
          skipped: true,
          owner: repo.owner,
          repo: repo.repo,
          reason: 'Repository disabled'
        });
        continue;
      }
      
      // Initialize repo state if not exists, or replace an entry of the wrong shape
      if (!isPlainObject(this.getRepoState(state, repo))) {
        state.repositories[this.getRepoKey(repo)] = {
          issuesCreatedToday: 0,
          lastIssueTime: null,
          todayTarget: null,
          nextIssueTime: null
        };
      }

      const repoState = this.getRepoState(state, repo);
      // A missing or non-numeric count would never reach the target (NaN >= n
      // is false), so issues would keep being created; start it over instead
      if (!isCount(repoState.issuesCreatedToday)) repoState.issuesCreatedToday = 0;

      // Determine today's target if not set, or re-roll it when the configured range changed
      if (repo.dailyTarget && this.resolveTodayTarget(repoState, repo.dailyTarget)) {
        logger.info(`Set daily target for ${repo.repo}`, { target: repoState.todayTarget });
      }
      
      // Check if we've reached today's target
      if (repoState.issuesCreatedToday >= repoState.todayTarget) {
        results.push({
          success: true,
          skipped: true,
          owner: repo.owner,
          repo: repo.repo,
          reason: `Daily target reached (${repoState.issuesCreatedToday}/${repoState.todayTarget})`
        });
        continue;
      }
      
      // Check if enough time has passed since last issue
      if (repoState.nextIssueTime && now < repoState.nextIssueTime) {
        const minutesRemaining = Math.round((repoState.nextIssueTime - now) / 60000);
        results.push({
          success: true,
          skipped: true,
          owner: repo.owner,
          repo: repo.repo,
          reason: `Waiting for interval (${minutesRemaining} minutes remaining)`
        });
        continue;
      }

      ready.push(repo);
    }

    // Apply repositorySelection (strategy, maxPerExecution) to the repositories
    // that can take an issue now, so selection slots are not spent on repos
    // that are done for the day or still waiting for their interval
    const selected = randomizer.selectRepositories(ready, fullConfig.repositorySelection, this.cursorStore);
    for (const repo of ready) {
      if (!selected.includes(repo)) {
        results.push({
          success: true,
          skipped: true,
          owner: repo.owner,
          repo: repo.repo,
          reason: 'Not selected this run'
        });
      }
    }

    for (const repo of selected) {
      const repoState = this.getRepoState(state, repo);
      let issueCreated = false;

      try {
        // Generate issue content
        const issueContent = this.generateIssueContent(repo, fullConfig);
        
        if (dryRun) {
          logger.info('DRY RUN: Would create issue', {
            repo: `${repo.owner}/${repo.repo}`,
            title: issueContent.title,
            labels: issueContent.labels
          });
          
          // Update state for dry run too
          repoState.issuesCreatedToday++;
          repoState.lastIssueTime = now;
          
          // Calculate next issue time with random interval
          if (repo.intervalMinutes) {
            const intervalMin = repo.intervalMinutes.min || 60;
            const intervalMax = repo.intervalMinutes.max || 180;
            const randomInterval = this.getRandomInt(intervalMin, intervalMax);
            repoState.nextIssueTime = now + (randomInterval * 60 * 1000);
          }
          
          results.push({
            success: true,
            owner: repo.owner,
            repo: repo.repo,
            dryRun: true,
            issue: issueContent,
            progress: `${repoState.issuesCreatedToday}/${repoState.todayTarget}`
          });
        } else {
          // Create the issue
          const { data: issue } = await this.client.issues.create({
            owner: repo.owner,
            repo: repo.repo,
            title: issueContent.title,
            body: issueContent.body,
            labels: issueContent.labels
          });
          
          logger.info('Issue created', {
            repo: `${repo.owner}/${repo.repo}`,
            number: issue.number,
            title: issue.title
          });
          
          // Update state
          repoState.issuesCreatedToday++;
          repoState.lastIssueTime = now;
          issueCreated = true;
          
          // Calculate next issue time with random interval
          if (repo.intervalMinutes) {
            const intervalMin = repo.intervalMinutes.min || 60;
            const intervalMax = repo.intervalMinutes.max || 180;
            const randomInterval = this.getRandomInt(intervalMin, intervalMax);
            repoState.nextIssueTime = now + (randomInterval * 60 * 1000);
            
            logger.info(`Next issue scheduled`, {
              repo: repo.repo,
              inMinutes: randomInterval,
              at: new Date(repoState.nextIssueTime).toLocaleString('en-US', { timeZone: timezone })
            });
          }
          
          results.push({
            success: true,
            owner: repo.owner,
            repo: repo.repo,
            issue: {
              number: issue.number,
              url: issue.html_url,
              title: issue.title
            },
            progress: `${repoState.issuesCreatedToday}/${repoState.todayTarget}`
          });
        }
      } catch (error) {
        logger.error('Failed to create issue', {
          repo: `${repo.owner}/${repo.repo}`,
          error: error.message
        });
        
        results.push({
          success: false,
          owner: repo.owner,
          repo: repo.repo,
          error: error.message
        });
      }

      // Persist after every created issue so a crash or restart mid-run
      // cannot lose the count and cause duplicates on the next run
      if (issueCreated) {
        await this.saveState(state);
      }
    }

    // Dry runs must not consume the real daily quota
    if (!dryRun) {
      await this.saveState(state);
    }

    return results;
  }

  async getStatus(repositories, timezone = 'UTC') {
    const state = await this.loadState();
    const statuses = [];
    // State from a previous day is only cleared by the next run; report what that run will see
    const stale = this.shouldResetDaily(state, timezone);
    const now = Date.now();

    for (const repo of repositories) {
      const repoState = state.repositories[this.getRepoKey(repo)] || state.repositories[repo.repo] || {};
      const todayState = stale ? {} : repoState;
      // An elapsed interval no longer holds the repo back (processRepositories
      // only waits while now < nextIssueTime), so it must not read as a future time
      const waiting = todayState.nextIssueTime && now < todayState.nextIssueTime;
      statuses.push({
        repo: `${repo.owner}/${repo.repo}`,
        issuesCreatedToday: todayState.issuesCreatedToday || 0,
        todayTarget: todayState.todayTarget || 'Not set',
        lastIssueTime: repoState.lastIssueTime ? new Date(repoState.lastIssueTime).toISOString() : 'Never',
        nextIssueTime: waiting ? new Date(todayState.nextIssueTime).toISOString() : 'Any time'
      });
    }
    
    // The CLI renders these instants in the configured timezone, not the host's
    return {
      lastDailyReset: state.lastDailyReset,
      timezone,
      repositories: statuses
    };
  }
}

export default AdvancedIssueHandler;
