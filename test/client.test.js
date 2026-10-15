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
