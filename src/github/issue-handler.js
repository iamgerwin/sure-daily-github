import GitHubClient from './client.js';
import state from '../utils/state.js';
import logger from '../utils/logger.js';
import randomizer from '../utils/randomizer.js';
import { getTemplateDateParts } from '../utils/template-date.js';

class IssueHandler {
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

  generateIssueContent(template, timezone = 'UTC', now = new Date()) {
    const { date, time, timestamp } = getTemplateDateParts(timezone, now);

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

  // Hourly/daily/weekly limits for a repo, shared by selection and creation
  checkLimits(repoConfig, config = {}, targetCount = null) {
    const { owner, repo, dailyTarget } = repoConfig;
    const timezone = config?.general?.timezone || 'UTC';
    const timeVar = config?.randomization?.timeVariations;

    const actualTarget = targetCount || dailyTarget;
    const dailyMax = typeof actualTarget === 'object' ? actualTarget.max : actualTarget;
    const hourlyMax = timeVar?.enabled ? timeVar?.hourly?.max : undefined;
    const weeklyMax = timeVar?.enabled ? timeVar?.weekly?.max : undefined;

    return state.isWithinLimits(owner, repo, { hourlyMax, dailyMax, weeklyMax }, timezone);
  }

  async createDailyIssue(repoConfig, contentTemplate, dryRun = false, targetCount = null, config = {}) {
    const { owner, repo } = repoConfig;

    try {
      const timezone = config?.general?.timezone || 'UTC';
      const check = this.checkLimits(repoConfig, config, targetCount);
      if (!check.allowed) {
        logger.info('Limit reached, skipping issue creation', { owner, repo, check });
        return { success: true, skipped: true, reason: 'limit_reached' };
      }

      if (dryRun) {
        logger.info('[DRY RUN] Would create issue', { owner, repo });
        return { success: true, dryRun: true };
      }

      // Generate issue content
      const { title, body } = this.generateIssueContent(contentTemplate, timezone);
      const labels = repoConfig.labels || ['automated'];

      // Create issue
      const result = await this.createIssue(owner, repo, title, body, labels);

      if (result.success) {
        state.recordAction(owner, repo, { type: 'issue', timezone });
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

  async createMultipleIssues(repoConfig, contentTemplate, count, dryRun = false, config = {}) {
    const { owner, repo } = repoConfig;
    const results = [];

    logger.info('Creating multiple issues', { owner, repo, count });

    for (let i = 0; i < count; i++) {
      const result = await this.createDailyIssue(repoConfig, contentTemplate, dryRun, null, config);

      results.push(result);

      if (!result.success || result.skipped) {
        break; // Stop if we hit target or encounter error
      }

      // Small delay between issues to avoid rate limiting; a dry run makes no API call
      if (!dryRun && i < count - 1) {
        await this.delay(2000);
      }
    }

    return results;
  }

  async processRepositories(repositories, contentTemplate, dryRun = false, config = {}) {
    const results = [];

    // Apply repository selection strategy
    const selectionConfig = config.repositorySelection || { strategy: 'sequential' };
    const randomizationConfig = config.randomization;

    // Apply repositorySelection only to repos still within their limits,
    // so maxPerExecution slots are not spent on repos that are done for now
    const ready = [];
    for (const repo of repositories.filter(r => r.enabled)) {
      if (this.checkLimits(repo, config).allowed) {
        ready.push(repo);
      } else {
        logger.info('Limit reached, skipping issue creation', { owner: repo.owner, repo: repo.repo });
        results.push({ owner: repo.owner, repo: repo.repo, success: true, skipped: true, reason: 'limit_reached' });
      }
    }

    const selectedRepos = randomizer.selectRepositories(ready, selectionConfig);
    for (const repo of ready) {
      if (!selectedRepos.includes(repo)) {
        results.push({ owner: repo.owner, repo: repo.repo, success: true, skipped: true, reason: 'not_selected' });
      }
    }

    logger.info('Processing repositories', {
      total: repositories.length,
      ready: ready.length,
      selected: selectedRepos.length,
      strategy: selectionConfig.strategy
    });

    for (const [index, repo] of selectedRepos.entries()) {
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
        const multiResults = await this.createMultipleIssues(repo, contentTemplate, issueCount, dryRun, config);

        // Aggregate results; `skipped` stays a boolean so the executor summary
        // does not count a limit-reached repo as both skipped and failed.
        // Any failed issue fails the repo, even after earlier ones succeeded,
        // so the run summary and exit code do not hide it.
        const successful = multiResults.filter(r => r.success && !r.skipped).length;
        const skippedCount = multiResults.filter(r => r.skipped).length;
        const failed = multiResults.filter(r => !r.success).length;

        results.push({
          owner: repo.owner,
          repo: repo.repo,
          success: failed === 0,
          skipped: successful === 0 && failed === 0 && skippedCount > 0,
          count: issueCount,
          successful,
          skippedCount,
          failed,
          details: multiResults
        });
      } else {
        const result = await this.createDailyIssue(repo, contentTemplate, dryRun, null, config);
        results.push({
          owner: repo.owner,
          repo: repo.repo,
          count: 1,
          ...result
        });
      }

      // Delay between repositories to avoid rate limiting, only after a repo
      // that called the API and only when another repo follows
      if (!dryRun && !results[results.length - 1].skipped && index < selectedRepos.length - 1) {
        await this.delay(1000);
      }
    }

    return results;
  }
}

export default IssueHandler;
