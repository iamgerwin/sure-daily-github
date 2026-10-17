import { createOctokit } from './octokit.js';
import logger from '../utils/logger.js';

// The contents API 404s on empty path segments ("a//b.md"), which a configured
// path with a trailing or doubled slash would otherwise produce for every commit
export function normalizeRepoPath(filePath) {
  const segments = String(filePath ?? '').split('/').filter(Boolean);
  if (segments.length === 0) {
    throw new Error(`Invalid repository file path: "${filePath}"`);
  }
  if (segments.some(segment => segment === '.' || segment === '..')) {
    throw new Error(`Repository file path must not contain "." or ".." segments: "${filePath}"`);
  }
  return segments.join('/');
}

const OPEN_PULL_REQUESTS_QUERY = `
  query ($owner: String!, $repo: String!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      pullRequests(states: OPEN, first: 100, after: $cursor) {
        nodes {
          number
          headRefName
          headRefOid
          baseRefName
          isCrossRepository
          mergeable
          mergeStateStatus
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

class GitHubClient {
  constructor(token) {
    if (!token) {
      throw new Error('GitHub token is required');
    }

    // Rate limit and transient failure retries are handled by createOctokit
    this.octokit = createOctokit({
      auth: token,
      userAgent: 'sure-daily-github/1.0.0'
    });

    this.authenticated = false;
  }

  async validate() {
    try {
      const { data } = await this.octokit.rest.users.getAuthenticated();
      this.authenticated = true;
      logger.info('GitHub authentication successful', { user: data.login });
      return { success: true, user: data.login, id: data.id };
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

  // Without a branch, the contents API reads from and writes to the repository's
  // default branch, so repos whose default is not "main" still work unconfigured
  async getFile(owner, repo, path, branch = null) {
    try {
      path = normalizeRepoPath(path);
      const params = { owner, repo, path };
      if (branch) params.ref = branch;
      const { data } = await this.octokit.rest.repos.getContent(params);
      return { success: true, data };
    } catch (error) {
      if (error.status === 404) {
        return { success: false, notFound: true };
      }
      logger.error('Failed to get file', { owner, repo, path, error: error.message });
      return { success: false, error: error.message };
    }
  }

  async createOrUpdateFile(owner, repo, path, content, message, branch = null) {
    try {
      path = normalizeRepoPath(path);

      // Check if file exists
      const existingFile = await this.getFile(owner, repo, path, branch);

      const params = {
        owner,
        repo,
        path,
        message,
        content: Buffer.from(content).toString('base64')
      };
      if (branch) params.branch = branch;

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

  // REST pull listings omit mergeability, which would cost one extra request
  // per PR; GraphQL returns it for a whole page at once
  // `shouldContinue` is checked before each page after the first; when it
  // stops pagination, the pages already fetched are returned with timedOut
  async listOpenPullRequests(owner, repo, { shouldContinue } = {}) {
    try {
      const pulls = [];
      let cursor = null;
      do {
        if (cursor && shouldContinue && !shouldContinue()) {
          return { success: true, data: pulls, timedOut: true, error: 'scan budget exhausted' };
        }
        const data = await this.octokit.graphql(OPEN_PULL_REQUESTS_QUERY, { owner, repo, cursor });
        const page = data.repository.pullRequests;
        pulls.push(...page.nodes);
        cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
      } while (cursor);
      return { success: true, data: pulls };
    } catch (error) {
      logger.error('Failed to list pull requests', { owner, repo, error: error.message });
      return { success: false, error: error.message };
    }
  }

  // Shared { success, data } / { success: false, error } wrapper for babysit calls
  async call(action, meta, fn) {
    try {
      return { success: true, data: await fn() };
    } catch (error) {
      logger.error(`Failed to ${action}`, { ...meta, error: error.message });
      return { success: false, error: error.message, status: error.status };
    }
  }

  async getAuthenticatedUser() {
    return this.call('get authenticated user', {}, async () => {
      const { data } = await this.octokit.rest.users.getAuthenticated();
      return { login: data.login, id: data.id };
    });
  }

  // The issues API filters by label server-side; pull requests are the issues
  // that carry a `pull_request` key
  async listLabeledPullRequests(owner, repo, label) {
    return this.call('list labeled pull requests', { owner, repo, label }, async () => {
      const issues = await this.octokit.paginate(this.octokit.rest.issues.listForRepo, {
        owner, repo, state: 'open', labels: label, per_page: 100
      });
      return issues.filter(issue => issue.pull_request);
    });
  }

  async getPullRequest(owner, repo, number) {
    return this.call('get pull request', { owner, repo, number }, async () => {
      const { data } = await this.octokit.rest.pulls.get({ owner, repo, pull_number: number });
      return data;
    });
  }

  async listReviewComments(owner, repo, number) {
    return this.call('list review comments', { owner, repo, number }, () =>
      this.octokit.paginate(this.octokit.rest.pulls.listReviewComments, { owner, repo, pull_number: number, per_page: 100 }));
  }

  async listReviews(owner, repo, number) {
    return this.call('list reviews', { owner, repo, number }, () =>
      this.octokit.paginate(this.octokit.rest.pulls.listReviews, { owner, repo, pull_number: number, per_page: 100 }));
  }

  async listIssueComments(owner, repo, number) {
    return this.call('list issue comments', { owner, repo, number }, () =>
      this.octokit.paginate(this.octokit.rest.issues.listComments, { owner, repo, issue_number: number, per_page: 100 }));
  }

  // GitHub only accepts replies to the top-level comment of a review thread
  async replyToReviewComment(owner, repo, number, commentId, body) {
    return this.call('reply to review comment', { owner, repo, number, commentId }, async () => {
      const { data } = await this.octokit.rest.pulls.createReplyForReviewComment({
        owner, repo, pull_number: number, comment_id: commentId, body
      });
      return data;
    });
  }

  async createIssueComment(owner, repo, number, body) {
    return this.call('create issue comment', { owner, repo, number }, async () => {
      const { data } = await this.octokit.rest.issues.createComment({ owner, repo, issue_number: number, body });
      return data;
    });
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
