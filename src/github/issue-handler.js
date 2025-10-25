import GitHubClient from './client.js';
import state from '../utils/state.js';
import logger from '../utils/logger.js';
import randomizer from '../utils/randomizer.js';

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

  async createDailyIssue(repoConfig, contentTemplate, dryRun = false, targetCount = null) {
    const { owner, repo, dailyTarget } = repoConfig;

    try {
      // Determine actual target (use override or config)
      const actualTarget = targetCount || dailyTarget;
      const target = typeof actualTarget === 'object' ? actualTarget.max : actualTarget;

      // Check if issue is needed
      if (!state.isCommitNeeded(owner, repo, target)) {
        logger.info('Daily target already met', { owner, repo, target });
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

  async createMultipleIssues(repoConfig, contentTemplate, count, dryRun = false) {
    const { owner, repo } = repoConfig;
    const results = [];

    logger.info('Creating multiple issues', { owner, repo, count });

    for (let i = 0; i < count; i++) {
      const result = await this.createDailyIssue(repoConfig, contentTemplate, dryRun, null);

      results.push(result);

      if (!result.success || result.skipped) {
        break; // Stop if we hit target or encounter error
      }

      // Small delay between issues to avoid rate limiting
      if (i < count - 1) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    return results;
  }

  async processRepositories(repositories, contentTemplate, dryRun = false, config = {}) {
    const results = [];

    // Apply repository selection strategy
    const selectionConfig = config.repositorySelection || { strategy: 'sequential' };
    const randomizationConfig = config.randomization;

    const selectedRepos = randomizer.selectRepositories(repositories, selectionConfig);

    logger.info('Processing repositories', {
      total: repositories.length,
      selected: selectedRepos.length,
      strategy: selectionConfig.strategy
    });

    for (const repo of selectedRepos) {
      if (!repo.enabled) {
        logger.debug('Repository disabled, skipping', {
          owner: repo.owner,
          repo: repo.repo
        });
        continue;
      }

      // Determine how many issues to create for this repo
      let issueCount = 1;

      if (randomizationConfig?.enabled) {
        // Use randomization config
        issueCount = randomizer.getRandomCountWithTimeVariation(randomizationConfig, 'daily');
        logger.info('Using randomized issue count', {
          owner: repo.owner,
          repo: repo.repo,
          count: issueCount
        });
      } else {
        // Use repo's dailyTarget range
        issueCount = randomizer.getRandomCount(repo.dailyTarget);
      }

      // Create issues for this repository
      if (issueCount > 1) {
        const multiResults = await this.createMultipleIssues(repo, contentTemplate, issueCount, dryRun);

        // Aggregate results
        const successful = multiResults.filter(r => r.success && !r.skipped).length;
        const skipped = multiResults.filter(r => r.skipped).length;
        const failed = multiResults.filter(r => !r.success).length;

        results.push({
          owner: repo.owner,
          repo: repo.repo,
          success: successful > 0,
          count: issueCount,
          successful,
          skipped,
          failed,
          details: multiResults
        });
      } else {
        const result = await this.createDailyIssue(repo, contentTemplate, dryRun);
        results.push({
          owner: repo.owner,
          repo: repo.repo,
          count: 1,
          ...result
        });
      }

      // Delay between repositories to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    return results;
  }
}

export default IssueHandler;
