import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createOctokit, getRetryDelayMs, getRequestRetries, isIdempotentRequest } from '../src/github/octokit.js';

// Serves the queued responses in order, recording each request method
async function startServer(responses) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.method);
    const { status, headers = {} } = responses[Math.min(requests.length - 1, responses.length - 1)];
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(status < 400 ? { login: 'me' } : { message: 'error' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    requests,
    octokit: createOctokit({ baseUrl: `http://127.0.0.1:${port}`, retry: { baseDelayMs: 5 } }),
    close: () => { server.closeAllConnections(); server.close(); }
  };
}

test('GET requests are retried after a transient 5xx', async () => {
  const srv = await startServer([{ status: 502 }, { status: 200 }]);
  try {
    const { data } = await srv.octokit.request('GET /user');
    assert.equal(data.login, 'me');
    assert.equal(srv.requests.length, 2);
  } finally {
    srv.close();
  }
});

test('POST requests are not retried after a 5xx to avoid duplicate writes', async () => {
  const srv = await startServer([{ status: 500 }, { status: 201 }]);
  try {
    await assert.rejects(srv.octokit.request('POST /repos/{owner}/{repo}/issues', { owner: 'me', repo: 'r', title: 't' }));
    assert.equal(srv.requests.length, 1);
  } finally {
    srv.close();
  }
});

test('POST requests are retried when rate limited with retry-after', async () => {
  const srv = await startServer([{ status: 403, headers: { 'retry-after': '0' } }, { status: 201 }]);
  try {
    await srv.octokit.request('POST /repos/{owner}/{repo}/issues', { owner: 'me', repo: 'r', title: 't' });
    assert.deepEqual(srv.requests, ['POST', 'POST']);
  } finally {
    srv.close();
  }
});

test('GraphQL queries are retried after a transient 5xx', async () => {
  const srv = await startServer([{ status: 502 }, { status: 200 }]);
  try {
    await srv.octokit.graphql('query ($owner: String!) { repository(owner: $owner, name: "r") { id } }', { owner: 'me' });
    assert.deepEqual(srv.requests, ['POST', 'POST']);
  } finally {
    srv.close();
  }
});

test('GraphQL mutations are not retried after a 5xx to avoid duplicate writes', async () => {
  const srv = await startServer([{ status: 502 }, { status: 200 }]);
  try {
    await assert.rejects(srv.octokit.graphql('mutation ($id: ID!) { pinIssue(input: { issueId: $id }) { clientMutationId } }', { id: 'x' }));
    assert.equal(srv.requests.length, 1);
  } finally {
    srv.close();
  }
});

test('isIdempotentRequest only treats reads as idempotent', () => {
  assert.equal(isIdempotentRequest('GET'), true);
  assert.equal(isIdempotentRequest({ method: 'head', url: '/x' }), true);
  assert.equal(isIdempotentRequest({ method: 'POST', url: '/graphql', query: '{ viewer { login } }' }), true);
  assert.equal(isIdempotentRequest({ method: 'POST', url: '/graphql', query: 'query Q { viewer { login } }' }), true);
  assert.equal(isIdempotentRequest({ method: 'POST', url: '/graphql', query: '  mutation { a }' }), false);
  assert.equal(isIdempotentRequest({ method: 'POST', url: '/graphql', query: 'subscription { a }' }), false);
  assert.equal(isIdempotentRequest({ method: 'POST', url: '/graphql', query: 'query A { a } mutation B { b }' }), false);
  assert.equal(isIdempotentRequest({ method: 'POST', url: '/graphql' }), false);
  assert.equal(isIdempotentRequest({ method: 'POST', url: '/repos/o/r/issues', query: '{ a }' }), false);
  assert.equal(isIdempotentRequest(undefined), false);
});

test('retries stop after the configured limit', async () => {
  const srv = await startServer([{ status: 503 }]);
  try {
    await assert.rejects(srv.octokit.request('GET /user'), err => err.status === 503);
    assert.equal(srv.requests.length, 3); // 1 attempt + 2 default retries
  } finally {
    srv.close();
  }
});

test('client errors such as 404 are not retried', async () => {
  const srv = await startServer([{ status: 404 }]);
  try {
    await assert.rejects(srv.octokit.request('GET /user'), err => err.status === 404);
    assert.equal(srv.requests.length, 1);
  } finally {
    srv.close();
  }
});

test('each retry of a timed-out GET gets a fresh deadline', async () => {
  let calls = 0;
  // First request stalls past the timeout; the second answers immediately
  const server = http.createServer((req, res) => {
    if (++calls === 1) return;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ login: 'me' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

  process.env.GITHUB_REQUEST_TIMEOUT_MS = '200';
  try {
    const octokit = createOctokit({
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      retry: { baseDelayMs: 5 }
    });
    const { data } = await octokit.request('GET /user');
    assert.equal(data.login, 'me');
    assert.equal(calls, 2);
  } finally {
    delete process.env.GITHUB_REQUEST_TIMEOUT_MS;
    server.closeAllConnections();
    server.close();
  }
});

test('getRetryDelayMs refuses to wait for a distant rate limit reset', () => {
  const reset = Math.floor(Date.now() / 1000) + 3600;
  const error = { status: 403, response: { headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) } } };
  assert.equal(getRetryDelayMs(error, 'GET', 0), null);
});

test('getRetryDelayMs treats a plain 403 as a permanent failure', () => {
  assert.equal(getRetryDelayMs({ status: 403, response: { headers: {} } }, 'GET', 0), null);
});

test('getRequestRetries reads GITHUB_REQUEST_RETRIES and falls back on invalid values', () => {
  process.env.GITHUB_REQUEST_RETRIES = '0';
  try {
    assert.equal(getRequestRetries(), 0);
    process.env.GITHUB_REQUEST_RETRIES = 'abc';
    assert.equal(getRequestRetries(), 2);
  } finally {
    delete process.env.GITHUB_REQUEST_RETRIES;
  }
});
