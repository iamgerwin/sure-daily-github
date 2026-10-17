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
