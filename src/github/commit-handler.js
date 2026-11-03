import GitHubClient from './client.js';
import state from '../utils/state.js';
import logger from '../utils/logger.js';
import randomizer from '../utils/randomizer.js';
import { getTemplateDateParts } from '../utils/template-date.js';

class CommitHandler {
  // Without a token only the local-state methods (getStatus) are usable
  constructor(token) {
    this.client = token ? new GitHubClient(token) : null;
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async init() {
    if (!this.client) {
      throw new Error('GitHub token is required');
    }
    const result = await this.client.validate();
    if (!result.success) {
      throw new Error('GitHub authentication failed');
    }
    return result;
  }

  // ${repo} is filled when the repository name is given, as in commit messages
  generateContent(template, timezone = 'UTC', now = new Date(), repo = null) {
    const { date, time, timestamp } = getTemplateDateParts(timezone, now);

    const content = template.body || `# Daily Update\n\nProgress update for ${date}`;

    const rendered = content
      .replace(/\$\{date\}/g, date)
      .replace(/\$\{time\}/g, time)
      .replace(/\$\{timestamp\}/g, timestamp);
    return repo ? rendered.replace(/\$\{repo\}/g, repo) : rendered;
  }

  // Supports the same ${date}, ${time} and ${timestamp} placeholders as the
  // content template, plus ${repo}
  generateCommitMessage(template, repo, timezone = 'UTC', now = new Date()) {
    const { date, time, timestamp } = getTemplateDateParts(timezone, now);
    const message = template || `docs: daily update ${date}`;

    return message
      .replace(/\$\{date\}/g, date)
      .replace(/\$\{time\}/g, time)
      .replace(/\$\{timestamp\}/g, timestamp)
      .replace(/\$\{repo\}/g, repo);
  }

  generateFilePath(basePath, repo, timezone = 'UTC', now = new Date()) {
    const { date } = getTemplateDateParts(timezone, now);
    const timestamp = now.getTime();

    // Create unique filename with date and timestamp
    return `${basePath}/${date}-${timestamp}.md`;
  }

  // The config loader normalizes dailyTarget to { min, max }; state limits need a
  // number, so a real range resolves to today's rolled target for the repository
  resolveDailyTarget({ owner, repo, dailyTarget }, timezone = 'UTC', now = new Date()) {
    if (dailyTarget && typeof dailyTarget === 'object') {
      return state.getDailyTarget(owner, repo, dailyTarget, timezone, now);
    }
    return dailyTarget || 1;
  }

  async createDailyCommit(repoConfig, contentTemplate, dryRun = false, timezone = 'UTC', now = new Date()) {
    const { owner, repo, branch, path: basePath, commitMessage } = repoConfig;

    try {
      // Check, date and count the commit from the same clock reading: counting it
      // after the API call could land a 23:59:59 commit in the next day's window
      const target = this.resolveDailyTarget(repoConfig, timezone, now);
      if (!state.isCommitNeeded(owner, repo, target, timezone, now)) {
        logger.info('Daily target already met', { owner, repo, target });
        return { success: true, skipped: true, reason: 'target_met' };
      }

      if (dryRun) {
        logger.info('[DRY RUN] Would create commit', { owner, repo, branch, basePath });
        return { success: true, dryRun: true };
      }

      const content = this.generateContent(contentTemplate, timezone, now, repo);
      const message = this.generateCommitMessage(commitMessage, repo, timezone, now);
      const filePath = this.generateFilePath(basePath, repo, timezone, now);

      // Fail before the API call: an uncounted commit would be repeated every run
      state.assertWritable();

      // Create commit
      const result = await this.client.createOrUpdateFile(
        owner,
        repo,
        filePath,
        content,
        message,
        branch
      );

      if (result.success) {
        state.recordCommit(owner, repo, timezone, now);
        logger.info('Daily commit created', {
          owner,
          repo,
          path: filePath,
          sha: result.data.commit.sha
        });
      }

      return result;
    } catch (error) {
      logger.error('Failed to create daily commit', {
        owner,
        repo,
        error: error.message
      });
      return { success: false, error: error.message };
    }
  }

  async processRepositories(repositories, contentTemplate, dryRun = false, config = {}) {
    const results = [];
    const timezone = config?.general?.timezone || 'UTC';
    const enabled = repositories.filter(repo => repo.enabled);

    // Apply repositorySelection only to repos that still need a commit today,
    // so maxPerExecution slots are not spent on repos whose target is met
    const ready = [];
    for (const repo of enabled) {
      const target = this.resolveDailyTarget(repo, timezone);
      if (state.isCommitNeeded(repo.owner, repo.repo, target, timezone)) {
        ready.push(repo);
      } else {
        logger.info('Daily target already met', { owner: repo.owner, repo: repo.repo, target });
        results.push({ owner: repo.owner, repo: repo.repo, success: true, skipped: true, reason: 'target_met' });
      }
    }

    const selected = randomizer.selectRepositories(ready, config?.repositorySelection, state, { dryRun });
    for (const repo of ready) {
      if (!selected.includes(repo)) {
        results.push({ owner: repo.owner, repo: repo.repo, success: true, skipped: true, reason: 'not_selected' });
      }
    }

    logger.info('Processing repositories', {
      total: repositories.length,
      ready: ready.length,
      selected: selected.length,
      strategy: config?.repositorySelection?.strategy || 'sequential'
    });

    for (const [index, repo] of selected.entries()) {
      const result = await this.createDailyCommit(repo, contentTemplate, dryRun, timezone);
      results.push({
        owner: repo.owner,
        repo: repo.repo,
        ...result
      });

      // Small delay to avoid rate limiting, only after a repo that called the
      // API (not a dry run or skip) and only when another repo follows
      if (!dryRun && !result.skipped && index < selected.length - 1) {
        await this.delay(1000);
      }
    }

    return results;
  }

  async getStatus(repositories, timezone = 'UTC') {
    const status = [];

    for (const repo of repositories) {
      const repoState = state.getRepoState(repo.owner, repo.repo);
      const target = this.resolveDailyTarget(repo, timezone);
      // Daily window counter covers both commits and issues (simple issue mode reuses this status)
      const { allowed: needsCommit, counts } = state.isWithinLimits(repo.owner, repo.repo, { dailyMax: target }, timezone);

      status.push({
        owner: repo.owner,
        repo: repo.repo,
        target,
        today: counts.daily,
        total: repoState.totalCommits,
        lastCommit: repoState.lastCommitDate,
        needsCommit
      });
    }

    return status;
  }
}

export default CommitHandler;
