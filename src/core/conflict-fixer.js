import fs from 'fs';
import os from 'os';
import path from 'path';
import GitHubClient from '../github/client.js';
import logger from '../utils/logger.js';
import { acquireRunLock } from '../utils/run-lock.js';
import { runGit, gitAuthEnv, scrubEnv } from '../utils/git.js';
import { detectTestCommand, runTestCommand, tailLines } from '../utils/test-detector.js';
import { resolveConflicts } from './conflict-resolver.js';

// GitHub computes mergeability lazily and reports UNKNOWN until it is done
export const UNKNOWN_RETRIES = 3;
export const UNKNOWN_RETRY_DELAY_MS = 2000;
export const DEFAULT_TEST_TIMEOUT_MINUTES = 15;

const FIXED_STATUSES = new Set(['fixed', 'would-fix']);

export function isConflicted(pr) {
  return pr.mergeable === 'CONFLICTING' || pr.mergeStateStatus === 'DIRTY';
}

// Unknown --repo values are rejected rather than ignored so a typo cannot
// silently process nothing
export function selectRepositories(repositories = [], filters = []) {
  const enabled = repositories.filter(r => r.enabled !== false);
  if (filters.length === 0) return enabled;

  return filters.map(filter => {
    const match = enabled.find(r => `${r.owner}/${r.repo}`.toLowerCase() === String(filter).toLowerCase());
    if (!match) throw new Error(`Repository not configured or disabled: ${filter}`);
    return match;
  });
}

export function summarize(results) {
  return {
    total: results.length,
    fixed: results.filter(r => FIXED_STATUSES.has(r.status)).length,
    needsManualReview: results.filter(r => r.status === 'needs-manual-review').length,
    skipped: results.filter(r => r.skipped && r.status !== 'needs-manual-review').length,
    failed: results.filter(r => !r.success).length
  };
}

function prResult(repoConfig, pr, status, extra = {}) {
  return {
    owner: repoConfig.owner,
    repo: repoConfig.repo,
    pr: pr.number,
    status,
    success: status !== 'error',
    skipped: !FIXED_STATUSES.has(status),
    ...extra
  };
}

function defaultRemoteUrl(owner, repo) {
  return `https://github.com/${owner}/${repo}.git`;
}

class ConflictFixer {
  constructor(token, options = {}) {
    this.client = options.client || new GitHubClient(token);
    this.git = options.git || runGit;
    this.runCommand = options.runCommand || runTestCommand;
    this.remoteUrl = options.remoteUrl || defaultRemoteUrl;
    this.workRoot = options.workRoot || os.tmpdir();
    this.retryDelayMs = options.retryDelayMs ?? UNKNOWN_RETRY_DELAY_MS;
    this.authEnv = gitAuthEnv(token);
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Shares the executor's lock so a fix run cannot race the scheduler
  async run(cfg, options = {}) {
    let lock;
    try {
      lock = acquireRunLock();
    } catch (error) {
      logger.error('Failed to acquire run lock', { error: error.message });
      return { success: false, error: `Failed to acquire run lock: ${error.message}` };
    }

    if (!lock.acquired) {
      const error = `Another execution is already in progress (pid ${lock.holder?.pid ?? 'unknown'})`;
      logger.warn(error, { holder: lock.holder });
      return { success: false, locked: true, error };
    }

    try {
      return await this.execute(cfg, options);
    } finally {
      lock.release();
    }
  }

  async execute(cfg, { repos = [], pr = null, dryRun = false, scanOnly = false } = {}) {
    try {
      const repositories = selectRepositories(cfg.repositories, repos);
      if (pr !== null && pr !== undefined && repos.length !== 1) {
        throw new Error('--pr requires exactly one --repo');
      }
      const prNumber = pr === null || pr === undefined ? null : Number(pr);
      dryRun = dryRun || cfg.general?.dryRun === true;

      const auth = await this.client.validate();
      if (!auth.success) {
        throw new Error('GitHub authentication failed');
      }
      const identity = {
        name: auth.user,
        email: auth.id ? `${auth.id}+${auth.user}@users.noreply.github.com` : `${auth.user}@users.noreply.github.com`
      };
      const settings = {
        testTimeoutMinutes: cfg.conflictFixer?.testTimeoutMinutes ?? DEFAULT_TEST_TIMEOUT_MINUTES,
        installDeps: cfg.conflictFixer?.installDeps ?? true
      };

      logger.info('Starting conflict fixer', { repositories: repositories.length, dryRun, scanOnly });

      const results = [];
      for (const repoConfig of repositories) {
        const { owner, repo } = repoConfig;
        const listed = await this.listPullRequests(owner, repo);
        if (!listed.success) {
          results.push({ owner, repo, status: 'error', success: false, skipped: false, error: listed.error });
          continue;
        }

        for (const pull of listed.data) {
          if (prNumber !== null && pull.number !== prNumber) continue;

          if (isConflicted(pull)) {
            if (pull.isCrossRepository) {
              results.push(prResult(repoConfig, pull, 'skipped', { reason: 'fork pull request' }));
            } else if (scanOnly) {
              results.push(prResult(repoConfig, pull, 'conflicted', { reason: `${pull.headRefName} -> ${pull.baseRefName}` }));
            } else {
              results.push(await this.fixPullRequest(repoConfig, pull, { dryRun, settings, identity }));
            }
          } else if (pull.mergeable === 'UNKNOWN' && !pull.isCrossRepository) {
            results.push(prResult(repoConfig, pull, 'unknown', { reason: 'GitHub has not computed mergeability yet' }));
          }
        }
      }

      const summary = summarize(results);
      logger.info('Conflict fixer completed', summary);
      return { success: true, results, summary };
    } catch (error) {
      logger.error('Conflict fixer failed', { error: error.message });
      return { success: false, error: error.message };
    }
  }

  async listPullRequests(owner, repo) {
    for (let attempt = 0; ; attempt++) {
      const result = await this.client.listOpenPullRequests(owner, repo);
      const pending = result.success
        && result.data.some(pr => !pr.isCrossRepository && pr.mergeable === 'UNKNOWN');
      if (!pending || attempt >= UNKNOWN_RETRIES) return result;
      await this.delay(this.retryDelayMs);
    }
  }

  async fixPullRequest(repoConfig, pr, { dryRun = false, settings = {}, identity }) {
    const { owner, repo } = repoConfig;
    const head = pr.headRefName;
    const base = pr.baseRefName;
    const url = this.remoteUrl(owner, repo);
    const timeoutMs = (settings.testTimeoutMinutes ?? DEFAULT_TEST_TIMEOUT_MINUTES) * 60 * 1000;
    const done = (status, extra) => {
      const result = prResult(repoConfig, pr, status, extra);
      logger.info('Conflict fixer result', { owner, repo, pr: pr.number, status, reason: result.reason });
      return result;
    };

    if (head === base) {
      return done('skipped', { reason: 'head and base are the same branch' });
    }

    const dir = fs.mkdtempSync(path.join(this.workRoot, 'sdg-fix-'));
    const git = (args, options = {}) => this.git(args, { cwd: dir, env: this.authEnv, ...options });
    const must = async (args) => {
      const result = await git(args);
      if (result.code !== 0) {
        throw new Error(`git ${args[0]} failed: ${String(result.stderr).trim()}`);
      }
      return result.stdout;
    };

    try {
      await must(['init', '-q']);
      // Merge needs an identity even with --no-commit
      await must(['config', 'user.name', identity.name]);
      await must(['config', 'user.email', identity.email]);
      await must(['fetch', '-q', '--no-tags', url,
        `+refs/heads/${base}:refs/remotes/origin/${base}`,
        `+refs/heads/${head}:refs/remotes/origin/${head}`]);

      // Only fix the exact commit GitHub reported as conflicting
      const fetchedHead = (await must(['rev-parse', `refs/remotes/origin/${head}`])).trim();
      if (fetchedHead !== pr.headRefOid) {
        return done('head-moved', { reason: `branch is at ${fetchedHead.slice(0, 7)}, expected ${pr.headRefOid.slice(0, 7)}` });
      }
      await must(['checkout', '-q', '--detach', pr.headRefOid]);

      const merge = await git(['-c', 'merge.conflictStyle=diff3', 'merge', '-q', '--no-ff', '--no-commit', `refs/remotes/origin/${base}`]);
      if (merge.code === 0) {
        return done('stale-status', { reason: 'merges cleanly locally; GitHub status is stale' });
      }
      if ((await git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).code !== 0) {
        throw new Error(`git merge failed: ${String(merge.stderr || merge.stdout).trim()}`);
      }

      const resolution = await resolveConflicts({ cwd: dir, git });
      if (!resolution.resolved) {
        return done('needs-manual-review', { reason: resolution.reason });
      }

      const files = resolution.files.map(f => f.file);
      await must([
        'commit', '-q', '--no-verify',
        '-m', `Merge branch '${base}' into ${head}`,
        '-m', `Auto-resolved conflicts (newer change per hunk): ${files.join(', ')}`
      ]);

      const gate = await this.runRegressionGate(dir, repoConfig, settings, timeoutMs);
      if (!gate.passed) {
        return done('needs-manual-review', { reason: gate.reason, output: gate.output, files });
      }

      if (dryRun) {
        return done('would-fix', { reason: `resolved ${files.length} file(s); tests passed`, files });
      }

      // Never forced: a rejected fast-forward means someone pushed meanwhile
      const push = await git(['push', '-q', url, `HEAD:refs/heads/${head}`]);
      if (push.code !== 0) {
        const stderr = String(push.stderr).trim();
        if (/rejected|non-fast-forward|fetch first/.test(stderr)) {
          return done('head-moved', { reason: 'branch changed before push', files });
        }
        throw new Error(`git push failed: ${stderr}`);
      }

      return done('fixed', { reason: `resolved ${files.length} file(s); tests passed`, files });
    } catch (error) {
      logger.error('Conflict fixer error', { owner, repo, pr: pr.number, error: error.message });
      return done('error', { error: `#${pr.number}: ${error.message}`, reason: error.message });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  async runRegressionGate(dir, repoConfig, settings, timeoutMs) {
    const commands = detectTestCommand(dir, repoConfig, settings);
    if (!commands) {
      return { passed: false, reason: 'no test command detected' };
    }

    // Tests run code from the PR branch, so they never see the GitHub token
    const env = { ...scrubEnv(process.env), CI: 'true' };
    const steps = [
      commands.install && { command: commands.install, label: 'dependency install' },
      { command: commands.test, label: 'tests' }
    ].filter(Boolean);

    for (const { command, label } of steps) {
      const result = await this.runCommand(command, { cwd: dir, env, timeoutMs });
      if (result.timedOut) {
        return { passed: false, reason: `${label} timed out (${command})`, output: tailLines(result.output) };
      }
      if (result.code !== 0) {
        return { passed: false, reason: `${label} failed (${command})`, output: tailLines(result.output) };
      }
    }
    return { passed: true };
  }
}

export default ConflictFixer;
