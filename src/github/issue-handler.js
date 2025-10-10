import GitHubClient from './client.js';
import state from '../utils/state.js';
import logger from '../utils/logger.js';

class IssueHandler {
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

  generateIssueContent(template) {
    const now = new Date();
    const date = now.toISOString().split('T')[0];
    const time = now.toTimeString().split(' ')[0];
    const timestamp = now.toISOString();

    const title = template.title || `Daily Update - ${date}`;
    const body = template.body || `# Daily Update\n\nAutomated update for ${date}`;

    return {
      title: title
        .replace(/\$\{date\}/g, date)
        .replace(/\$\{time\}/g, time)
        .replace(/\$\{timestamp\}/g, timestamp),
      body: body
        .replace(/\$\{date\}/g, date)
        .replace(/\$\{time\}/g, time)
        .replace(/\$\{timestamp\}/g, timestamp)
    };
  }

  async createIssue(owner, repo, title, body, labels = []) {
    try {
      const { data } = await this.client.octokit.rest.issues.create({
        owner,
        repo,
        title,
        body,
        labels
      });

      logger.info('Issue created successfully', {
        owner,
        repo,
        number: data.number,
        url: data.html_url
      });

      return {
        success: true,
        data: {
          number: data.number,
          url: data.html_url,
          title: data.title
        }
      };
    } catch (error) {
      logger.error('Failed to create issue', {
        owner,
        repo,
        error: error.message
      });
      return { success: false, error: error.message };
    }
  }

  async createDailyIssue(repoConfig, contentTemplate, dryRun = false) {
    const { owner, repo, dailyTarget } = repoConfig;

    try {
      // Check if issue is needed
      if (!state.isCommitNeeded(owner, repo, dailyTarget)) {
        logger.info('Daily target already met', { owner, repo, target: dailyTarget });
        return { success: true, skipped: true, reason: 'target_met' };
      }

      if (dryRun) {
        logger.info('[DRY RUN] Would create issue', { owner, repo });
        return { success: true, dryRun: true };
      }

      // Generate issue content
      const { title, body } = this.generateIssueContent(contentTemplate);
      const labels = repoConfig.labels || ['automated'];

      // Create issue
      const result = await this.createIssue(owner, repo, title, body, labels);

      if (result.success) {
        state.recordCommit(owner, repo); // Reuse state tracking
        logger.info('Daily issue created', {
          owner,
          repo,
          number: result.data.number,
          url: result.data.url
        });
      }

      return result;
    } catch (error) {
      logger.error('Failed to create daily issue', {
        owner,
        repo,
        error: error.message
      });
      return { success: false, error: error.message };
    }
  }

  async processRepositories(repositories, contentTemplate, dryRun = false) {
    const results = [];

    for (const repo of repositories) {
      if (!repo.enabled) {
        logger.debug('Repository disabled, skipping', {
          owner: repo.owner,
          repo: repo.repo
        });
        continue;
      }

      const result = await this.createDailyIssue(repo, contentTemplate, dryRun);
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
}

export default IssueHandler;
