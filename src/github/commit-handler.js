import GitHubClient from './client.js';
import state from '../utils/state.js';
import logger from '../utils/logger.js';
import randomizer from '../utils/randomizer.js';
import { getTemplateDateParts } from '../utils/template-date.js';

class CommitHandler {
  constructor(token) {
    this.client = new GitHubClient(token);
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async init() {
    const result = await this.client.validate();
    if (!result.success) {
      throw new Error('GitHub authentication failed');
    }
    return result;
  }

  generateContent(template, timezone = 'UTC', now = new Date()) {
    const { date, time, timestamp } = getTemplateDateParts(timezone, now);

    const content = template.body || `# Daily Update\n\nProgress update for ${date}`;

    return content
      .replace(/\$\{date\}/g, date)
      .replace(/\$\{time\}/g, time)
      .replace(/\$\{timestamp\}/g, timestamp);
  }

  generateCommitMessage(template, repo, timezone = 'UTC', now = new Date()) {
    const { date } = getTemplateDateParts(timezone, now);
    const message = template || `docs: daily update ${date}`;

    return message
      .replace(/\$\{date\}/g, date)
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

  async createDailyCommit(repoConfig, contentTemplate, dryRun = false, timezone = 'UTC') {
    const { owner, repo, branch, path: basePath, commitMessage } = repoConfig;

    try {
      // Check if commit is needed
      const target = this.resolveDailyTarget(repoConfig, timezone);
      if (!state.isCommitNeeded(owner, repo, target, timezone)) {
        logger.info('Daily target already met', { owner, repo, target });
        return { success: true, skipped: true, reason: 'target_met' };
      }

      if (dryRun) {
        logger.info('[DRY RUN] Would create commit', { owner, repo, branch, basePath });
        return { success: true, dryRun: true };
      }

      // Generate content and commit details
      const content = this.generateContent(contentTemplate, timezone);
      const message = this.generateCommitMessage(commitMessage, repo, timezone);
      const filePath = this.generateFilePath(basePath, repo, timezone);

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
        state.recordCommit(owner, repo, timezone);
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

    const selected = randomizer.selectRepositories(ready, config?.repositorySelection);
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

    for (const repo of selected) {
      const result = await this.createDailyCommit(repo, contentTemplate, dryRun, timezone);
      results.push({
        owner: repo.owner,
        repo: repo.repo,
        ...result
      });

      // Small delay to avoid rate limiting
      await this.delay(1000);
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
