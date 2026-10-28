import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createOctokit, getRetryDelayMs, SECONDARY_RATE_LIMIT_DELAY_MS, MAX_RETRY_DELAY_MS, getRequestRetries, getRequestTimeoutMs, isIdempotentRequest, parseRetryAfterMs, graphqlRateLimitError } from '../src/github/octokit.js';
import { MAX_TIMER_MS } from '../src/utils/process.js';

// Serves the queued responses in order, recording each request method
async function startServer(responses, retry = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.method);
    const { status, headers = {}, message = 'error', body } = responses[Math.min(requests.length - 1, responses.length - 1)];
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body ?? (status < 400 ? { login: 'me' } : { message })));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    requests,
    octokit: createOctokit({ baseUrl: `http://127.0.0.1:${port}`, retry: { baseDelayMs: 5, ...retry } }),
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

const GRAPHQL_QUERY = 'query ($owner: String!) { repository(owner: $owner, name: "r") { id } }';
const RATE_LIMITED = { status: 200, body: { data: null, errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] } };
const GRAPHQL_OK = { status: 200, body: { data: { repository: { id: 'R_1' } } } };

test('GraphQL queries are retried after a RATE_LIMITED response', async () => {
  const srv = await startServer([RATE_LIMITED, GRAPHQL_OK]);
  try {
    const data = await srv.octokit.graphql(GRAPHQL_QUERY, { owner: 'me' });
    assert.deepEqual(data, { repository: { id: 'R_1' } });
    assert.deepEqual(srv.requests, ['POST', 'POST']);
  } finally {
    srv.close();
  }
});

test('GraphQL mutations are retried after a RATE_LIMITED response since none ran', async () => {
  const srv = await startServer([RATE_LIMITED, { status: 200, body: { data: { pinIssue: null } } }]);
  try {
    await srv.octokit.graphql('mutation ($id: ID!) { pinIssue(input: { issueId: $id }) { clientMutationId } }', { id: 'x' });
    assert.equal(srv.requests.length, 2);
  } finally {
    srv.close();
  }
});

test('GraphQL RATE_LIMITED responses reject with the GraphQL error once retries run out', async () => {
  const srv = await startServer([RATE_LIMITED]);
  try {
    await assert.rejects(srv.octokit.graphql(GRAPHQL_QUERY, { owner: 'me' }), /API rate limit exceeded/);
    assert.equal(srv.requests.length, 3); // 1 attempt + 2 default retries
  } finally {
    srv.close();
  }
});

test('GraphQL RATE_LIMITED responses are not retried for a distant rate limit reset', async () => {
  const reset = String(Math.floor(Date.now() / 1000) + 3600);
  const srv = await startServer([
    { ...RATE_LIMITED, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset } },
    GRAPHQL_OK
  ]);
  try {
    await assert.rejects(srv.octokit.graphql(GRAPHQL_QUERY, { owner: 'me' }), /API rate limit exceeded/);
    assert.equal(srv.requests.length, 1);
  } finally {
    srv.close();
  }
});

test('other GraphQL errors are not retried', async () => {
  const srv = await startServer([
    { status: 200, body: { data: null, errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to a Repository' }] } },
    GRAPHQL_OK
  ]);
  try {
    await assert.rejects(srv.octokit.graphql(GRAPHQL_QUERY, { owner: 'me' }), /Could not resolve/);
    assert.equal(srv.requests.length, 1);
  } finally {
    srv.close();
  }
});

test('graphqlRateLimitError only flags RATE_LIMITED GraphQL responses', () => {
  assert.equal(graphqlRateLimitError({ status: 200, data: { login: 'me' } }), null);
  assert.equal(graphqlRateLimitError({ status: 200, data: { errors: [{ type: 'NOT_FOUND' }] } }), null);
  assert.equal(graphqlRateLimitError(undefined), null);
  const error = graphqlRateLimitError({ status: 200, headers: {}, data: { errors: [{ type: 'RATE_LIMITED', message: 'slow down' }] } });
  assert.equal(error.message, 'slow down');
  assert.equal(getRetryDelayMs(error, { method: 'POST', url: '/graphql', query: 'mutation { a }' }, 0, 10), 10);
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

const SECONDARY_MESSAGE = 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.';

test('getRetryDelayMs waits a minute after a secondary rate limit 403 without headers', async () => {
  // Capture the error octokit really raises, so the message format is covered
  const srv = await startServer([{ status: 403, message: SECONDARY_MESSAGE }], { retries: 0 });
  try {
    const error = await srv.octokit.request('POST /repos/{owner}/{repo}/issues', { owner: 'me', repo: 'r', title: 't' })
      .then(() => assert.fail('expected a 403'), err => err);
    assert.equal(error.status, 403);
    assert.equal(getRetryDelayMs(error, 'POST', 0), SECONDARY_RATE_LIMIT_DELAY_MS);
    assert.ok(SECONDARY_RATE_LIMIT_DELAY_MS <= MAX_RETRY_DELAY_MS);
  } finally {
    srv.close();
  }
});

test('getRetryDelayMs waits a minute after a secondary rate limit 429 without headers', () => {
  const error = { status: 429, message: SECONDARY_MESSAGE, response: { headers: {} } };
  assert.equal(getRetryDelayMs(error, 'GET', 0), SECONDARY_RATE_LIMIT_DELAY_MS);
  assert.equal(getRetryDelayMs({ ...error, message: 'You have triggered an abuse detection mechanism.' }, 'GET', 0), SECONDARY_RATE_LIMIT_DELAY_MS);
});

test('getRetryDelayMs prefers retry-after over the secondary rate limit default', () => {
  const error = { status: 403, message: SECONDARY_MESSAGE, response: { headers: { 'retry-after': '3' } } };
  assert.equal(getRetryDelayMs(error, 'POST', 0), 3000);
});

test('parseRetryAfterMs reads delay-seconds and HTTP-dates', () => {
  const now = Date.parse('Wed, 21 Oct 2026 07:28:00 GMT');
  assert.equal(parseRetryAfterMs('3', now), 3000);
  assert.equal(parseRetryAfterMs(' 0 ', now), 0);
  assert.equal(parseRetryAfterMs('Wed, 21 Oct 2026 07:28:30 GMT', now), 30000);
  assert.equal(parseRetryAfterMs('Wed, 21 Oct 2026 07:27:50 GMT', now), -10000);
  for (const value of ['', 'soon', '1.5', '-5']) {
    assert.ok(Number.isNaN(parseRetryAfterMs(value, now)), `expected NaN for ${JSON.stringify(value)}`);
  }
});

test('getRetryDelayMs waits until a retry-after HTTP-date', () => {
  const retryAt = new Date(Math.ceil(Date.now() / 1000) * 1000 + 20000).toUTCString();
  const error = { status: 429, response: { headers: { 'retry-after': retryAt } } };
  const delay = getRetryDelayMs(error, 'POST', 0);
  assert.ok(delay > 15000 && delay <= 21000, `expected about 20s, got ${delay}`);
});

test('getRetryDelayMs gives up on a retry-after HTTP-date beyond the maximum delay', () => {
  const retryAt = new Date(Date.now() + MAX_RETRY_DELAY_MS + 60000).toUTCString();
  const error = { status: 429, response: { headers: { 'retry-after': retryAt } } };
  assert.equal(getRetryDelayMs(error, 'POST', 0), null);
});

test('getRetryDelayMs retries at once when a retry-after HTTP-date has passed', () => {
  const error = { status: 429, response: { headers: { 'retry-after': new Date(Date.now() - 5000).toUTCString() } } };
  assert.equal(getRetryDelayMs(error, 'POST', 0), 0);
});

test('getRetryDelayMs falls back to the secondary rate limit wait for an unparseable retry-after', () => {
  const error = { status: 403, message: SECONDARY_MESSAGE, response: { headers: { 'retry-after': 'soon' } } };
  assert.equal(getRetryDelayMs(error, 'POST', 0), SECONDARY_RATE_LIMIT_DELAY_MS);
});

test('getRetryDelayMs ignores a distant x-ratelimit-reset on a secondary rate limit with quota left', () => {
  const reset = String(Math.floor(Date.now() / 1000) + 3600);
  const error = { status: 403, message: SECONDARY_MESSAGE, response: { headers: { 'x-ratelimit-remaining': '4990', 'x-ratelimit-reset': reset } } };
  assert.equal(getRetryDelayMs(error, 'POST', 0), SECONDARY_RATE_LIMIT_DELAY_MS);
});

test('POST requests are retried after a secondary rate limit with retry-after', async () => {
  const srv = await startServer([{ status: 403, message: SECONDARY_MESSAGE, headers: { 'retry-after': '0' } }, { status: 201 }]);
  try {
    await srv.octokit.request('POST /repos/{owner}/{repo}/issues', { owner: 'me', repo: 'r', title: 't' });
    assert.deepEqual(srv.requests, ['POST', 'POST']);
  } finally {
    srv.close();
  }
});

test('getRetryDelayMs still treats a 403 permission error as permanent', () => {
  const error = { status: 403, message: 'Resource not accessible by integration', response: { headers: {} } };
  assert.equal(getRetryDelayMs(error, 'POST', 0), null);
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

test('getRequestTimeoutMs caps GITHUB_REQUEST_TIMEOUT_MS at the timer limit', () => {
  process.env.GITHUB_REQUEST_TIMEOUT_MS = '9999999999';
  try {
    assert.equal(getRequestTimeoutMs(), MAX_TIMER_MS);
    process.env.GITHUB_REQUEST_TIMEOUT_MS = '45000';
    assert.equal(getRequestTimeoutMs(), 45000);
    process.env.GITHUB_REQUEST_TIMEOUT_MS = '-1';
    assert.equal(getRequestTimeoutMs(), 30000);
  } finally {
    delete process.env.GITHUB_REQUEST_TIMEOUT_MS;
  }
});

test('a very long GITHUB_REQUEST_TIMEOUT_MS does not abort requests at once', async () => {
  process.env.GITHUB_REQUEST_TIMEOUT_MS = '9999999999';
  const srv = await startServer([{ status: 200 }]);
  try {
    const { data } = await srv.octokit.request('GET /user');
    assert.equal(data.login, 'me');
  } finally {
    srv.close();
    delete process.env.GITHUB_REQUEST_TIMEOUT_MS;
  }
});
