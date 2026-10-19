import { Octokit } from '@octokit/rest';
import logger from '../utils/logger.js';

export const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
export const DEFAULT_REQUEST_RETRIES = 2;
export const DEFAULT_RETRY_BASE_DELAY_MS = 1000;
// Never sleep longer than this for a rate limit reset; fail the run instead
export const MAX_RETRY_DELAY_MS = 60000;

const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD']);

export function getRequestTimeoutMs() {
  const value = Number(process.env.GITHUB_REQUEST_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_REQUEST_TIMEOUT_MS;
}

export function getRequestRetries() {
  const raw = process.env.GITHUB_REQUEST_RETRIES;
  const value = Number(raw);
  return raw !== undefined && raw !== '' && Number.isInteger(value) && value >= 0
    ? value
    : DEFAULT_REQUEST_RETRIES;
}

function isRateLimited(error) {
  const headers = error.response?.headers || {};
  if (error.status === 429) return true;
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

// Rate-limited requests were rejected before being processed, so any method is
// safe to retry. 5xx and network/timeout failures may have been applied server
// side, so only idempotent reads are retried to avoid duplicate issues/commits.
// `request` is the request options (or just its method).
export function getRetryDelayMs(error, request, attempt, baseDelayMs = DEFAULT_RETRY_BASE_DELAY_MS) {
  const backoff = baseDelayMs * 2 ** attempt;

  if (isRateLimited(error)) {
    const headers = error.response?.headers || {};
    let delay = backoff;
    if (headers['retry-after'] !== undefined) {
      delay = Number(headers['retry-after']) * 1000;
    } else if (headers['x-ratelimit-reset'] !== undefined) {
      delay = Number(headers['x-ratelimit-reset']) * 1000 - Date.now();
    }
    if (!Number.isFinite(delay)) delay = backoff;
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

      try {
        return await request(requestOptions);
      } catch (error) {
        const delay = attempt < retries
          ? getRetryDelayMs(error, requestOptions, attempt, baseDelayMs)
          : null;
        if (delay === null) throw error;

        logger.warn('GitHub request failed, retrying', {
          method: requestOptions.method,
          url: requestOptions.url,
          status: error.status,
          attempt: attempt + 1,
          delayMs: delay
        });
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  });

  return octokit;
}
