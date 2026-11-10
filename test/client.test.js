import test from 'node:test';
import assert from 'node:assert/strict';

const { default: GitHubClient, normalizeRepoPath } = await import('../src/github/client.js');

function stubClient({ getContent } = {}) {
  const client = new GitHubClient('ghp_test');
  const calls = { getContent: [], put: [] };
  client.octokit = {
    rest: {
      repos: {
        getContent: async (params) => {
          calls.getContent.push(params);
          if (getContent) return getContent(params);
          const error = new Error('Not Found');
          error.status = 404;
          throw error;
        },
        createOrUpdateFileContents: async (params) => {
          calls.put.push(params);
          return { data: { commit: { sha: 'abc123' } } };
        }
      }
    }
  };
  return { client, calls };
}

test('listLabeledPullRequests filters open issues by label and keeps only pull requests', async () => {
  const client = new GitHubClient('ghp_test');
  const calls = [];
  const listForRepo = () => {};
  client.octokit = {
    rest: { issues: { listForRepo } },
    paginate: async (method, params) => {
      calls.push({ method, params });
      return [
        { number: 1, title: 'plain issue' },
        { number: 2, title: 'a PR', pull_request: { url: 'x' } }
      ];
    }
  };

  const result = await client.listLabeledPullRequests('me', 'demo', 'babysit');
  assert.equal(result.success, true);
  assert.deepEqual(result.data.map(i => i.number), [2]);
  assert.equal(calls[0].method, listForRepo);
  assert.deepEqual(calls[0].params, { owner: 'me', repo: 'demo', state: 'open', labels: 'babysit', per_page: 100 });
});

test('replyToReviewComment posts a thread reply and reports API errors without throwing', async () => {
  const client = new GitHubClient('ghp_test');
  const calls = [];
  client.octokit = {
    rest: {
      pulls: {
        createReplyForReviewComment: async (params) => {
          calls.push(params);
          if (params.comment_id === 404) {
            const error = new Error('Not Found');
            error.status = 404;
            throw error;
          }
          return { data: { id: 77 } };
        }
      }
    }
  };

  const ok = await client.replyToReviewComment('me', 'demo', 7, 11, 'Fixed');
  assert.deepEqual(ok, { success: true, data: { id: 77 } });
  assert.deepEqual(calls[0], { owner: 'me', repo: 'demo', pull_number: 7, comment_id: 11, body: 'Fixed' });

  const failed = await client.replyToReviewComment('me', 'demo', 7, 404, 'Fixed');
  assert.equal(failed.success, false);
  assert.equal(failed.status, 404);
  assert.match(failed.error, /Not Found/);
});

test('normalizeRepoPath collapses leading, trailing, and doubled slashes', () => {
  assert.equal(normalizeRepoPath('daily-updates/2026-10-15-1.md'), 'daily-updates/2026-10-15-1.md');
  assert.equal(normalizeRepoPath('daily-updates//2026-10-15-1.md'), 'daily-updates/2026-10-15-1.md');
  assert.equal(normalizeRepoPath('/daily-updates/2026-10-15-1.md'), 'daily-updates/2026-10-15-1.md');
  assert.equal(normalizeRepoPath('notes/daily///x.md'), 'notes/daily/x.md');
});

test('normalizeRepoPath rejects empty and relative-segment paths', () => {
  assert.throws(() => normalizeRepoPath(''), /Invalid repository file path/);
  assert.throws(() => normalizeRepoPath('//'), /Invalid repository file path/);
  assert.throws(() => normalizeRepoPath(undefined), /Invalid repository file path/);
  assert.throws(() => normalizeRepoPath('../secrets/x.md'), /must not contain/);
  assert.throws(() => normalizeRepoPath('./daily/x.md'), /must not contain/);
});

test('createOrUpdateFile sends a normalized path when the base path has a trailing slash', async () => {
  const { client, calls } = stubClient();
  const result = await client.createOrUpdateFile('me', 'demo', 'daily-updates//2026-10-15-1.md', 'hi', 'docs: update', 'main');

  assert.equal(result.success, true);
  assert.equal(calls.getContent[0].path, 'daily-updates/2026-10-15-1.md');
  assert.equal(calls.put[0].path, 'daily-updates/2026-10-15-1.md');
  assert.equal(calls.put[0].sha, undefined);
});

test('createOrUpdateFile passes the existing sha for updates', async () => {
  const { client, calls } = stubClient({ getContent: async () => ({ data: { sha: 'old' } }) });
  const result = await client.createOrUpdateFile('me', 'demo', '/notes/today.md', 'hi', 'docs: update');

  assert.equal(result.success, true);
  assert.equal(calls.put[0].path, 'notes/today.md');
  assert.equal(calls.put[0].sha, 'old');
});

test('createOrUpdateFile fails without calling the API for an invalid path', async () => {
  const { client, calls } = stubClient();
  const result = await client.createOrUpdateFile('me', 'demo', '../escape.md', 'hi', 'docs: update');

  assert.equal(result.success, false);
  assert.match(result.error, /must not contain/);
  assert.equal(calls.getContent.length, 0);
  assert.equal(calls.put.length, 0);
});

test('createOrUpdateFile does not write when the existence lookup fails with a non-404 error', async () => {
  const { client, calls } = stubClient({
    getContent: async () => {
      const error = new Error('Resource not accessible by integration');
      error.status = 403;
      throw error;
    }
  });
  const result = await client.createOrUpdateFile('me', 'demo', 'daily-updates/x.md', 'hi', 'docs: update', 'main');

  assert.equal(result.success, false);
  assert.match(result.error, /Could not check whether daily-updates\/x\.md exists: Resource not accessible by integration/);
  assert.equal(calls.getContent.length, 1);
  assert.equal(calls.put.length, 0);
});

test('getFile normalizes the path and reports 404 as notFound', async () => {
  const { client, calls } = stubClient();
  const result = await client.getFile('me', 'demo', 'daily-updates//x.md');

  assert.deepEqual(result, { success: false, notFound: true });
  assert.equal(calls.getContent[0].path, 'daily-updates/x.md');
});

test('createOrUpdateFile omits branch and ref when none is configured', async () => {
  const { client, calls } = stubClient();
  const result = await client.createOrUpdateFile('me', 'demo', 'daily-updates/x.md', 'hi', 'docs: update', null);

  assert.equal(result.success, true);
  assert.equal('ref' in calls.getContent[0], false);
  assert.equal('branch' in calls.put[0], false);
});

test('createOrUpdateFile targets the configured branch for both lookup and write', async () => {
  const { client, calls } = stubClient();
  await client.createOrUpdateFile('me', 'demo', 'daily-updates/x.md', 'hi', 'docs: update', 'master');

  assert.equal(calls.getContent[0].ref, 'master');
  assert.equal(calls.put[0].branch, 'master');
});

test('listOpenPullRequests follows GraphQL pagination', async () => {
  const client = new GitHubClient('ghp_test');
  const calls = [];
  const pages = [
    { nodes: [{ number: 1, mergeable: 'CONFLICTING' }], pageInfo: { hasNextPage: true, endCursor: 'c1' } },
    { nodes: [{ number: 2, mergeable: 'MERGEABLE' }], pageInfo: { hasNextPage: false, endCursor: 'c2' } }
  ];
  client.octokit = {
    graphql: async (query, variables) => {
      calls.push(variables);
      return { repository: { pullRequests: pages[calls.length - 1] } };
    }
  };

  const result = await client.listOpenPullRequests('me', 'demo');

  assert.equal(result.success, true);
  assert.deepEqual(result.data.map(pr => pr.number), [1, 2]);
  assert.deepEqual(calls, [
    { owner: 'me', repo: 'demo', cursor: null },
    { owner: 'me', repo: 'demo', cursor: 'c1' }
  ]);
});

test('listOpenPullRequests reports API failures', async () => {
  const client = new GitHubClient('ghp_test');
  client.octokit = { graphql: async () => { throw new Error('Could not resolve to a Repository'); } };

  const result = await client.listOpenPullRequests('me', 'missing');

  assert.deepEqual(result, { success: false, error: 'Could not resolve to a Repository' });
});

test('listOpenPullRequests stops before the next page when shouldContinue is false', async () => {
  const client = new GitHubClient('ghp_test');
  let pages = 0;
  client.octokit = {
    graphql: async () => {
      pages++;
      return { repository: { pullRequests: { nodes: [{ number: pages }], pageInfo: { hasNextPage: true, endCursor: `c${pages}` } } } };
    }
  };

  const result = await client.listOpenPullRequests('me', 'demo', { shouldContinue: () => pages < 2 });

  assert.equal(pages, 2);
  assert.deepEqual(result, {
    success: true, data: [{ number: 1 }, { number: 2 }], timedOut: true, error: 'scan budget exhausted'
  });
});

test('listOpenPullRequests keeps the first page when the budget expires before page 2', async () => {
  const client = new GitHubClient('ghp_test');
  let pages = 0;
  client.octokit = {
    graphql: async () => {
      pages++;
      return { repository: { pullRequests: { nodes: [{ number: pages }], pageInfo: { hasNextPage: true, endCursor: `c${pages}` } } } };
    }
  };

  const result = await client.listOpenPullRequests('me', 'demo', { shouldContinue: () => false });

  assert.equal(pages, 1);
  assert.equal(result.success, true);
  assert.equal(result.timedOut, true);
  assert.deepEqual(result.data, [{ number: 1 }]);
});

function apiError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

// Babysit reads and writes go through these wrappers; the babysitter tests stub
// the whole client, so the GitHub parameters they send are only checked here
function stubBabysitClient({ fail = null } = {}) {
  const client = new GitHubClient('ghp_test');
  const calls = [];
  const endpoint = (name, data) => async (params) => {
    calls.push({ name, params });
    if (fail?.[name]) throw fail[name];
    return { data };
  };
  const rest = {
    users: { getAuthenticated: endpoint('getAuthenticated', { login: 'octo', id: 42, name: 'ignored' }) },
    pulls: {
      get: endpoint('pulls.get', { number: 7, head: { sha: 'abc' } }),
      listReviewComments: endpoint('pulls.listReviewComments', []),
      listReviews: endpoint('pulls.listReviews', [])
    },
    issues: {
      listComments: endpoint('issues.listComments', []),
      createComment: endpoint('issues.createComment', { id: 99 })
    }
  };
  const names = new Map([
    [rest.pulls.listReviewComments, 'pulls.listReviewComments'],
    [rest.pulls.listReviews, 'pulls.listReviews'],
    [rest.issues.listComments, 'issues.listComments']
  ]);
  client.octokit = {
    rest,
    paginate: async (method, params) => {
      const name = names.get(method);
      calls.push({ name: `paginate:${name}`, params });
      if (fail?.[name]) throw fail[name];
      return [{ id: 1, via: name }];
    }
  };
  return { client, calls };
}

test('getAuthenticatedUser returns only the login and id', async () => {
  const { client } = stubBabysitClient();
  assert.deepEqual(await client.getAuthenticatedUser(), { success: true, data: { login: 'octo', id: 42 } });
});

test('getAuthenticatedUser reports an auth failure with its status instead of throwing', async () => {
  const { client } = stubBabysitClient({ fail: { getAuthenticated: apiError('Bad credentials', 401) } });
  const result = await client.getAuthenticatedUser();
  assert.equal(result.success, false);
  assert.equal(result.status, 401);
  assert.match(result.error, /Bad credentials/);
});

test('getPullRequest requests the pull by pull_number and returns its data', async () => {
  const { client, calls } = stubBabysitClient();
  const result = await client.getPullRequest('me', 'demo', 7);
  assert.deepEqual(result, { success: true, data: { number: 7, head: { sha: 'abc' } } });
  assert.deepEqual(calls, [{ name: 'pulls.get', params: { owner: 'me', repo: 'demo', pull_number: 7 } }]);
});

// babysitter.lookupHead treats status 404 as a deleted pull request and any
// other failure as transient, so the status must survive the wrapper
test('getPullRequest keeps the HTTP status of a failed lookup', async () => {
  const gone = stubBabysitClient({ fail: { 'pulls.get': apiError('Not Found', 404) } });
  const missing = await gone.client.getPullRequest('me', 'demo', 7);
  assert.equal(missing.success, false);
  assert.equal(missing.status, 404);

  const flaky = stubBabysitClient({ fail: { 'pulls.get': apiError('fetch failed') } });
  const transient = await flaky.client.getPullRequest('me', 'demo', 7);
  assert.equal(transient.success, false);
  assert.equal(transient.status, undefined);
  assert.match(transient.error, /fetch failed/);
});

test('listing review comments, reviews and issue comments paginates every page of the pull request', async () => {
  const { client, calls } = stubBabysitClient();
  const results = [
    await client.listReviewComments('me', 'demo', 7),
    await client.listReviews('me', 'demo', 7),
    await client.listIssueComments('me', 'demo', 7)
  ];

  assert.deepEqual(results.map(r => r.data[0].via), ['pulls.listReviewComments', 'pulls.listReviews', 'issues.listComments']);
  assert.ok(results.every(r => r.success));
  assert.deepEqual(calls, [
    { name: 'paginate:pulls.listReviewComments', params: { owner: 'me', repo: 'demo', pull_number: 7, per_page: 100 } },
    { name: 'paginate:pulls.listReviews', params: { owner: 'me', repo: 'demo', pull_number: 7, per_page: 100 } },
    // Conversation comments live on the issue API, keyed by issue_number
    { name: 'paginate:issues.listComments', params: { owner: 'me', repo: 'demo', issue_number: 7, per_page: 100 } }
  ]);
});

test('a failed comment listing is reported with its status instead of throwing', async () => {
  const { client } = stubBabysitClient({ fail: { 'pulls.listReviews': apiError('Server Error', 502) } });
  const result = await client.listReviews('me', 'demo', 7);
  assert.equal(result.success, false);
  assert.equal(result.status, 502);
  assert.match(result.error, /Server Error/);
});

test('createIssueComment posts to the pull request conversation by issue_number', async () => {
  const { client, calls } = stubBabysitClient();
  const result = await client.createIssueComment('me', 'demo', 7, 'Summary');
  assert.deepEqual(result, { success: true, data: { id: 99 } });
  assert.deepEqual(calls, [{ name: 'issues.createComment', params: { owner: 'me', repo: 'demo', issue_number: 7, body: 'Summary' } }]);

  const failing = stubBabysitClient({ fail: { 'issues.createComment': apiError('Forbidden', 403) } });
  const failed = await failing.client.createIssueComment('me', 'demo', 7, 'Summary');
  assert.equal(failed.success, false);
  assert.equal(failed.status, 403);
});
