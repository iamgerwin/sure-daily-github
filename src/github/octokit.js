import { Octokit } from '@octokit/rest';
import logger from '../utils/logger.js';
import { clampTimerMs } from '../utils/process.js';

export const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
export const DEFAULT_REQUEST_RETRIES = 2;
export const DEFAULT_RETRY_BASE_DELAY_MS = 1000;
// Never sleep longer than this for a rate limit reset; fail the run instead
export const MAX_RETRY_DELAY_MS = 60000;
// GitHub asks clients to wait at least a minute after a secondary rate limit
// response that carries neither retry-after nor x-ratelimit-* headers
export const SECONDARY_RATE_LIMIT_DELAY_MS = 60000;

const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD']);

// Capped at the timer limit: AbortSignal.timeout fires after 1ms beyond it, which
// would abort every request at once
export function getRequestTimeoutMs() {
  const value = Number(process.env.GITHUB_REQUEST_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? clampTimerMs(value) : DEFAULT_REQUEST_TIMEOUT_MS;
}

export function getRequestRetries() {
  const raw = process.env.GITHUB_REQUEST_RETRIES;
  const value = Number(raw);
  return raw !== undefined && raw !== '' && Number.isInteger(value) && value >= 0
    ? value
    : DEFAULT_REQUEST_RETRIES;
}

// A secondary (abuse) limit may arrive as a 403 without any rate limit
// headers; only the error message then tells it apart from a permission error
function isSecondaryRateLimit(error) {
  return (error.status === 403 || error.status === 429)
    && /secondary rate limit|abuse detection/i.test(String(error.message || ''));
}

function isRateLimited(error) {
  const headers = error.response?.headers || {};
  if (error.graphqlRateLimited) return true;
  if (error.status === 429) return true;
  if (isSecondaryRateLimit(error)) return true;
  return error.status === 403
    && (headers['retry-after'] !== undefined || headers['x-ratelimit-remaining'] === '0');
}

// GraphQL reads are POSTs to /graphql. A document that never names a mutation
// or subscription is read-only; matching the word anywhere (comments, field
// names) only errs towards not retrying.
export function isIdempotentRequest(request) {
  const { method, url, query } = typeof request === 'string' ? { method: request } : request || {};
  if (IDEMPOTENT_METHODS.has(String(method).toUpperCase())) return true;
  return url === '/graphql' && typeof query === 'string' && !/\b(mutation|subscription)\b/.test(query);
}

// Retry-After is either a number of seconds or an HTTP-date (RFC 9110). A date
// would otherwise read as NaN and fall back to a backoff of a second or two,
// retrying long before the server allows it. Unparseable values return NaN.
export function parseRetryAfterMs(value, now = Date.now()) {
  const text = String(value).trim();
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  const date = Date.parse(text);
  return /[a-z]/i.test(text) && Number.isFinite(date) ? date - now : NaN;
}

// GraphQL reports a spent rate limit as a 200 whose body carries a RATE_LIMITED
// error. The graphql layer only throws it after the request hook returns, so the
// hook has to recognize it itself. Returns an error to retry on, or null.
export function graphqlRateLimitError(response) {
  const errors = response?.data?.errors;
  if (!Array.isArray(errors) || !errors.some(e => e?.type === 'RATE_LIMITED')) return null;
  const error = new Error(errors.find(e => e?.type === 'RATE_LIMITED').message || 'GraphQL rate limit exceeded');
  return Object.assign(error, { status: response.status, response, graphqlRateLimited: true });
}

// Rate-limited requests were rejected before being processed, so any method is
// safe to retry. 5xx and network/timeout failures may have been applied server
// side, so only idempotent reads are retried to avoid duplicate issues/commits.
// `request` is the request options (or just its method).
export function getRetryDelayMs(error, request, attempt, baseDelayMs = DEFAULT_RETRY_BASE_DELAY_MS) {
  const backoff = baseDelayMs * 2 ** attempt;

  if (isRateLimited(error)) {
    const headers = error.response?.headers || {};
    const fallback = isSecondaryRateLimit(error) ? Math.max(backoff, SECONDARY_RATE_LIMIT_DELAY_MS) : backoff;
    let delay = fallback;
    if (headers['retry-after'] !== undefined) {
      delay = parseRetryAfterMs(headers['retry-after']);
    } else if (headers['x-ratelimit-remaining'] === '0' && headers['x-ratelimit-reset'] !== undefined) {
      // Every response carries x-ratelimit-reset; it only applies once the
      // primary limit is spent, not to a secondary limit with quota left
      delay = Number(headers['x-ratelimit-reset']) * 1000 - Date.now();
    }
    if (!Number.isFinite(delay)) delay = fallback;
    return delay > MAX_RETRY_DELAY_MS ? null : Math.max(delay, 0);
  }

  const transient = error.status === undefined || error.status >= 500;
  if (transient && isIdempotentRequest(request)) {
    return backoff;
  }

  return null;
}

// Every GitHub API call gets an abort deadline (per attempt) so a stalled
// connection cannot keep a scheduled execution (and the scheduler's overlap
// guard) stuck, and transient failures are retried with bounded backoff
export function createOctokit(options = {}) {
  const { retry = {}, ...octokitOptions } = options;
  const octokit = new Octokit(octokitOptions);
  const timeoutMs = getRequestTimeoutMs();
  const retries = retry.retries ?? getRequestRetries();
  const baseDelayMs = retry.baseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;

  octokit.hook.wrap('request', async (request, requestOptions) => {
    // Inner hooks are bound to this same options object, so the per-attempt
    // signal must be set on it in place rather than on a copy
    requestOptions.request = requestOptions.request || {};
    const callerSignal = requestOptions.request.signal;

    for (let attempt = 0; ; attempt++) {
      requestOptions.request.signal = callerSignal || AbortSignal.timeout(timeoutMs);

      let response;
      let failure;
      try {
        response = await request(requestOptions);
        failure = graphqlRateLimitError(response);
        if (!failure) return response;
      } catch (error) {
        failure = error;
      }

      const delay = attempt < retries
        ? getRetryDelayMs(failure, requestOptions, attempt, baseDelayMs)
        : null;
      if (delay === null) {
        // A GraphQL response goes back as is, so the caller gets GitHub's own error
        if (response) return response;
        throw failure;
      }

      logger.warn('GitHub request failed, retrying', {
        method: requestOptions.method,
        url: requestOptions.url,
        status: failure.status,
        attempt: attempt + 1,
        delayMs: delay
      });
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  });

  return octokit;
}
