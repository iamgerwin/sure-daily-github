import { Octokit } from '@octokit/rest';
import logger from '../utils/logger.js';

class GitHubClient {
  constructor(token) {
    if (!token) {
      throw new Error('GitHub token is required');
    }

    this.octokit = new Octokit({
      auth: token,
      userAgent: 'sure-daily-github/1.0.0',
      throttle: {
        onRateLimit: (retryAfter, options) => {
          logger.warn(`Rate limit hit, retrying after ${retryAfter}s`, {
            method: options.method,
            url: options.url
          });
          return true; // Retry once
        },
        onSecondaryRateLimit: (retryAfter, options) => {
          logger.warn(`Secondary rate limit hit`, {
            method: options.method,
            url: options.url
          });
          return false; // Don't retry
        }
      }
    });

    this.authenticated = false;
  }

  async validate() {
    try {
      const { data } = await this.octokit.rest.users.getAuthenticated();
      this.authenticated = true;
      logger.info('GitHub authentication successful', { user: data.login });
      return { success: true, user: data.login };
    } catch (error) {
      logger.error('GitHub authentication failed', { error: error.message });
      return { success: false, error: error.message };
    }
  }

  async getRepository(owner, repo) {
    try {
      const { data } = await this.octokit.rest.repos.get({ owner, repo });
      return { success: true, data };
    } catch (error) {
      logger.error('Failed to get repository', { owner, repo, error: error.message });
      return { success: false, error: error.message };
    }
  }

  async getDefaultBranch(owner, repo) {
    const result = await this.getRepository(owner, repo);
    if (result.success) {
      return result.data.default_branch;
    }
    return 'main';
  }

  async getBranch(owner, repo, branch) {
    try {
      const { data } = await this.octokit.rest.repos.getBranch({ owner, repo, branch });
      return { success: true, data };
    } catch (error) {
      logger.error('Failed to get branch', { owner, repo, branch, error: error.message });
      return { success: false, error: error.message };
    }
  }

  async getFile(owner, repo, path, branch = 'main') {
    try {
      const { data } = await this.octokit.rest.repos.getContent({
        owner,
        repo,
        path,
        ref: branch
      });
      return { success: true, data };
    } catch (error) {
      if (error.status === 404) {
        return { success: false, notFound: true };
      }
      logger.error('Failed to get file', { owner, repo, path, error: error.message });
      return { success: false, error: error.message };
    }
  }

  async createOrUpdateFile(owner, repo, path, content, message, branch = 'main') {
    try {
      // Check if file exists
      const existingFile = await this.getFile(owner, repo, path, branch);

      const params = {
        owner,
        repo,
        path,
        message,
        content: Buffer.from(content).toString('base64'),
        branch
      };

      // If file exists, include sha for update
      if (existingFile.success && existingFile.data.sha) {
        params.sha = existingFile.data.sha;
      }

      const { data } = await this.octokit.rest.repos.createOrUpdateFileContents(params);

      logger.info('File committed successfully', {
        owner,
        repo,
        path,
        sha: data.commit.sha
      });

      return { success: true, data };
    } catch (error) {
      logger.error('Failed to create/update file', {
        owner,
        repo,
        path,
        error: error.message
      });
      return { success: false, error: error.message };
    }
  }

  async getRateLimit() {
    try {
      const { data } = await this.octokit.rest.rateLimit.get();
      return {
        core: {
          limit: data.resources.core.limit,
          remaining: data.resources.core.remaining,
          reset: new Date(data.resources.core.reset * 1000)
        }
      };
    } catch (error) {
      return { error: error.message };
    }
  }
}

export default GitHubClient;
