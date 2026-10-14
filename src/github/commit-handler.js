import GitHubClient from './client.js';
import state from '../utils/state.js';
import logger from '../utils/logger.js';

class CommitHandler {
  constructor(token) {
    this.client = new GitHubClient(token);
  }

  async init() {
    const result = await this.client.validate();
    if (!result.success) {
      throw new Error('GitHub authentication failed');
    }
    return result;
  }

  generateContent(template) {
    const now = new Date();
    const date = now.toISOString().split('T')[0];
    const time = now.toTimeString().split(' ')[0];
    const timestamp = now.toISOString();

    const content = template.body || `# Daily Update\n\nProgress update for ${date}`;

    return content
      .replace(/\$\{date\}/g, date)
      .replace(/\$\{time\}/g, time)
      .replace(/\$\{timestamp\}/g, timestamp);
  }

  generateCommitMessage(template, repo) {
    const date = new Date().toISOString().split('T')[0];
    const message = template || `docs: daily update ${date}`;

    return message
      .replace(/\$\{date\}/g, date)
      .replace(/\$\{repo\}/g, repo);
  }

  generateFilePath(basePath, repo) {
    const date = new Date().toISOString().split('T')[0];
    const timestamp = Date.now();

    // Create unique filename with date and timestamp
    return `${basePath}/${date}-${timestamp}.md`;
  }

  // The config loader normalizes dailyTarget to { min, max }; state limits need a number
  resolveDailyMax(dailyTarget) {
    if (dailyTarget && typeof dailyTarget === 'object') {
      return dailyTarget.max;
    }
    return dailyTarget || 1;
  }

  async createDailyCommit(repoConfig, contentTemplate, dryRun = false, timezone = 'UTC') {
    const { owner, repo, branch, path: basePath, commitMessage, dailyTarget } = repoConfig;

    try {
      // Check if commit is needed
      if (!state.isCommitNeeded(owner, repo, this.resolveDailyMax(dailyTarget), timezone)) {
        logger.info('Daily target already met', { owner, repo, target: dailyTarget });
        return { success: true, skipped: true, reason: 'target_met' };
      }

      if (dryRun) {
        logger.info('[DRY RUN] Would create commit', { owner, repo, branch, basePath });
        return { success: true, dryRun: true };
      }

      // Generate content and commit details
      const content = this.generateContent(contentTemplate);
      const message = this.generateCommitMessage(commitMessage, repo);
      const filePath = this.generateFilePath(basePath, repo);

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

    for (const repo of repositories) {
      if (!repo.enabled) {
        logger.debug('Repository disabled, skipping', {
          owner: repo.owner,
          repo: repo.repo
        });
        continue;
      }

      const result = await this.createDailyCommit(repo, contentTemplate, dryRun, timezone);
      results.push({
        owner: repo.owner,
        repo: repo.repo,
        ...result
      });

      // Small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    return results;
  }

  async getStatus(repositories, timezone = 'UTC') {
    const status = [];

    for (const repo of repositories) {
      const repoState = state.getRepoState(repo.owner, repo.repo);
      const target = this.resolveDailyMax(repo.dailyTarget);
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
