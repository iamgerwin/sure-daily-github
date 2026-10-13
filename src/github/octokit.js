import { Octokit } from '@octokit/rest';

export const DEFAULT_REQUEST_TIMEOUT_MS = 30000;

export function getRequestTimeoutMs() {
  const value = Number(process.env.GITHUB_REQUEST_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_REQUEST_TIMEOUT_MS;
}

// Every GitHub API call gets an abort deadline so a stalled connection cannot
// keep a scheduled execution (and the scheduler's overlap guard) stuck
export function createOctokit(options = {}) {
  const octokit = new Octokit(options);
  const timeoutMs = getRequestTimeoutMs();

  octokit.hook.before('request', (requestOptions) => {
    requestOptions.request = requestOptions.request || {};
    if (!requestOptions.request.signal) {
      requestOptions.request.signal = AbortSignal.timeout(timeoutMs);
    }
  });

  return octokit;
}
