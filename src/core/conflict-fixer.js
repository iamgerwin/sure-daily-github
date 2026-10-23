import fs from 'fs';
import os from 'os';
import path from 'path';
import GitHubClient from '../github/client.js';
import logger from '../utils/logger.js';
import { acquireRunLock } from '../utils/run-lock.js';
import { runGit, gitAuthEnv, scrubEnv } from '../utils/git.js';
import { detectTestCommand, runTestCommand, killActiveTests, tailLines } from '../utils/test-detector.js';
import { FixerLedger, ledgerKey } from '../utils/fixer-ledger.js';
import { resolveConflicts } from './conflict-resolver.js';

// GitHub computes mergeability lazily and reports UNKNOWN until it is done
export const UNKNOWN_RETRIES = 3;
export const UNKNOWN_RETRY_DELAY_MS = 2000;
export const DEFAULT_TEST_TIMEOUT_MINUTES = 15;
export const DEFAULT_SCAN_TIMEOUT_SECONDS = 120;
export const DEFAULT_ATTEMPT_TTL_MINUTES = 60;
export const DEFAULT_RETRY_COOLDOWN_MINUTES = 240;

const FIXED_STATUSES = new Set(['fixed', 'would-fix']);
const SIGNALS = ['SIGINT', 'SIGTERM'];
const PUSH_BLOCKED_PROTOCOLS = ['ext', 'file', 'git', 'ssh'];
// What `git init --bare` writes across git versions; anything else was planted
const FRESH_PUSH_CONFIG_KEYS = new Set([
  'core.repositoryformatversion', 'core.filemode', 'core.bare', 'core.logallrefupdates',
  'core.ignorecase', 'core.precomposeunicode', 'core.symlinks'
]);

export function isFreshPushConfig({ code, stdout }) {
  if (code !== 0) return false;
  return String(stdout).split('\n').filter(Boolean)
    .every(key => FRESH_PUSH_CONFIG_KEYS.has(key.toLowerCase()));
}

// Shared by the --scan-timeout option parser and execute()
export function parseScanTimeout(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`--scan-timeout must be a positive number of seconds: ${value}`);
  }
  return seconds;
}

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

// Opt-in gate: returns the skip reason for a repository, or null if allowed.
// With no configuration the allowlist is empty, so nothing is ever fixed.
export function gateReason(repoConfig, conflictFixer = {}) {
  if (repoConfig.conflictFixer === false) return 'disabled-per-repo';
  if (repoConfig.conflictFixer === true) return null;

  const name = `${repoConfig.owner}/${repoConfig.repo}`.toLowerCase();
  const listed = (list) => (list || []).some(entry => String(entry).toLowerCase() === name);
  if (listed(conflictFixer?.denylist)) return 'denylisted';
  if ((conflictFixer?.mode ?? 'allowlist') === 'allowlist' && !listed(conflictFixer?.allowlist)) {
    return 'not-allowlisted';
  }
  return null;
}

export function summarize(results) {
  return {
    total: results.length,
    fixed: results.filter(r => FIXED_STATUSES.has(r.status)).length,
    needsManualReview: results.filter(r => r.status === 'needs-manual-review').length,
    skipped: results.filter(r => r.skipped && !['needs-manual-review', 'scan-timeout'].includes(r.status)).length,
    scanTimeout: results.filter(r => r.status === 'scan-timeout').length,
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
    this.killTests = options.killTests || killActiveTests;
    this.remoteUrl = options.remoteUrl || defaultRemoteUrl;
    this.workRoot = options.workRoot || os.tmpdir();
    this.retryDelayMs = options.retryDelayMs ?? UNKNOWN_RETRY_DELAY_MS;
    this.authEnv = gitAuthEnv(token);
    this.ledger = options.ledger || new FixerLedger();
    this.now = options.now || Date.now;
    this.exit = options.exit || ((code) => process.exit(code));
    this.activeKeys = new Set();
    this.activeDir = null;
    this.activePushDir = null;
    this.lock = null;
    this.interrupted = false;
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

    this.lock = lock;
    const removeSignalHandlers = this.installSignalHandlers();
    try {
      return await this.execute(cfg, options);
    } finally {
      removeSignalHandlers();
      this.lock = null;
      lock.release();
    }
  }

  // Marks this run's in-progress ledger entries as interrupted so the next run
  // does not wait out the attempt TTL, then exits non-zero. A repeated signal
  // is ignored.
  interrupt(signal) {
    if (this.interrupted) return;
    this.interrupted = true;
    logger.warn('Conflict fixer interrupted', { signal, inProgress: [...this.activeKeys] });
    // Install/test commands run in their own process group, so they would
    // outlive this process and keep writing to the clone
    this.killTests();
    try {
      this.ledger.markInterrupted(this.activeKeys, this.now());
    } catch (error) {
      logger.error('Failed to mark interrupted attempts', { error: error.message });
    }
    for (const dir of [this.activeDir, this.activePushDir]) {
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
    this.lock?.release();
    this.exit(signal === 'SIGINT' ? 130 : 143);
  }

  installSignalHandlers() {
    const handlers = SIGNALS.map(signal => [signal, () => this.interrupt(signal)]);
    handlers.forEach(([signal, handler]) => process.on(signal, handler));
    return () => handlers.forEach(([signal, handler]) => process.off(signal, handler));
  }

  // Lists every repository's open PRs within the scan budget. Repositories not
  // fully listed before the deadline are returned as timedOut.
  async gather(repositories, deadline) {
    const remaining = () => deadline - this.now();
    const scanned = [];
    for (const repoConfig of repositories) {
      if (remaining() <= 0) {
        scanned.push({ repoConfig, timedOut: true });
        continue;
      }
      const listed = await this.listPullRequests(repoConfig.owner, repoConfig.repo, remaining);
      scanned.push({ repoConfig, ...listed });
    }
    return scanned;
  }

  async execute(cfg, { repos = [], pr = null, dryRun = false, scanOnly = false, scanTimeoutSeconds = null } = {}) {
    try {
      const repositories = selectRepositories(cfg.repositories, repos);
      if (pr !== null && pr !== undefined && repos.length !== 1) {
        throw new Error('--pr requires exactly one --repo');
      }
      // Only plain digits: Number() would read "1e2", "0x10" or "7.0" as some
      // other pull request number and fix that one instead
      const prNumber = pr === null || pr === undefined ? null : Number(pr);
      if (prNumber !== null && (!/^\d+$/.test(String(pr)) || !Number.isSafeInteger(prNumber) || prNumber <= 0)) {
        throw new Error('--pr must be a positive integer');
      }
      dryRun = dryRun || cfg.general?.dryRun === true;
      const scanBudgetSeconds = scanTimeoutSeconds === null || scanTimeoutSeconds === undefined
        ? cfg.conflictFixer?.scanTimeoutSeconds ?? DEFAULT_SCAN_TIMEOUT_SECONDS
        : parseScanTimeout(scanTimeoutSeconds);
      const attemptTtlMs = (cfg.conflictFixer?.attemptTtlMinutes ?? DEFAULT_ATTEMPT_TTL_MINUTES) * 60 * 1000;
      const retryCooldownMs = (cfg.conflictFixer?.retryCooldownMinutes ?? DEFAULT_RETRY_COOLDOWN_MINUTES) * 60 * 1000;

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
        installDeps: cfg.conflictFixer?.installDeps ?? true,
        sourceHunks: cfg.conflictFixer?.sourceHunks ?? 'push'
      };

      logger.info('Starting conflict fixer', { repositories: repositories.length, dryRun, scanOnly, scanBudgetSeconds });

      // Gated-out repositories are never listed, so they cost no API calls
      const gates = new Map(repositories.map(r => [r, gateReason(r, cfg.conflictFixer)]));
      const allowed = repositories.filter(r => !gates.get(r));

      // The budget covers only gathering; collected PRs are always processed
      const scanned = new Map((await this.gather(allowed, this.now() + scanBudgetSeconds * 1000))
        .map(entry => [entry.repoConfig, entry]));

      const results = [];
      for (const repoConfig of repositories) {
        const { owner, repo } = repoConfig;
        if (gates.get(repoConfig)) {
          results.push({ owner, repo, status: 'skipped', success: true, skipped: true, reason: gates.get(repoConfig) });
          continue;
        }
        // A repo cut off by the budget still has its already-listed PRs processed
        const { success, timedOut, data = [], error } = scanned.get(repoConfig);
        if (!success && !timedOut) {
          results.push({ owner, repo, status: 'error', success: false, skipped: false, error });
          continue;
        }

        for (const pull of data) {
          if (prNumber !== null && pull.number !== prNumber) continue;

          if (isConflicted(pull)) {
            if (pull.isCrossRepository) {
              results.push(prResult(repoConfig, pull, 'skipped', { reason: 'fork pull request' }));
            } else if (scanOnly) {
              results.push(prResult(repoConfig, pull, 'conflicted', { reason: `${pull.headRefName} -> ${pull.baseRefName}` }));
            } else {
              results.push(await this.attemptPullRequest(repoConfig, pull, {
                dryRun, settings, identity, attemptTtlMs, retryCooldownMs
              }));
            }
          } else if (pull.mergeable === 'UNKNOWN' && !pull.isCrossRepository) {
            results.push(prResult(repoConfig, pull, 'unknown', { reason: 'GitHub has not computed mergeability yet' }));
          }
        }
        if (timedOut) {
          results.push({ owner, repo, status: 'scan-timeout', success: true, skipped: true, reason: 'scan budget exhausted' });
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

  // Re-polls while GitHub reports UNKNOWN mergeability, but only while the
  // budget can cover the sleep; the last complete listing is kept on expiry
  async listPullRequests(owner, repo, remaining = () => Infinity) {
    const shouldContinue = () => remaining() > 0;
    let result = await this.client.listOpenPullRequests(owner, repo, { shouldContinue });
    for (let attempt = 0; attempt < UNKNOWN_RETRIES; attempt++) {
      const pending = result.success
        && result.data.some(pr => !pr.isCrossRepository && pr.mergeable === 'UNKNOWN');
      if (!pending || remaining() <= this.retryDelayMs) break;
      await this.delay(this.retryDelayMs);
      const retried = await this.client.listOpenPullRequests(owner, repo, { shouldContinue });
      if (retried.timedOut) break;
      result = retried;
    }
    return result;
  }

  // Ledger-guarded wrapper around fixPullRequest. Dry runs honour the ledger
  // but never write it, so a rehearsal cannot block the real fix.
  async attemptPullRequest(repoConfig, pr, { dryRun, settings, identity, attemptTtlMs, retryCooldownMs }) {
    const key = ledgerKey(repoConfig.owner, repoConfig.repo, pr.number);
    const skip = this.ledger.skipReason(key, pr.headRefOid, { now: this.now(), attemptTtlMs, retryCooldownMs });
    if (skip) {
      return prResult(repoConfig, pr, 'skipped', { reason: skip });
    }

    if (dryRun) {
      return this.fixPullRequest(repoConfig, pr, { dryRun, settings, identity });
    }

    this.ledger.start(key, pr.headRefOid, this.now());
    this.activeKeys.add(key);
    try {
      const result = await this.fixPullRequest(repoConfig, pr, { dryRun, settings, identity });
      this.ledger.finish(key, result.status, this.now());
      return result;
    } finally {
      this.activeKeys.delete(key);
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

    const root = fs.mkdtempSync(path.join(this.workRoot, 'sdg-fix-'));
    this.activeDir = root;
    const dir = path.join(root, 'repo');
    fs.mkdirSync(dir);
    // Hooks are switched off on the command line, which beats anything the
    // tested code writes to .git/hooks or core.hooksPath in .git/config
    const git = (args, options = {}) => this.git(['-c', `core.hooksPath=${os.devNull}`, ...args], {
      cwd: dir, env: this.authEnv, ...options
    });
    // For the clone once tested code has run in it: its .git/config is no longer
    // trusted (core.fsmonitor, http.proxy, ...), so no credential goes near it
    const untrusted = { env: {}, baseEnv: scrubEnv(process.env) };
    // Credential-bearing calls drop ambient GIT_* settings (GIT_CONFIG_PARAMETERS etc.)
    const authScrubbed = { env: this.authEnv, baseEnv: scrubEnv(process.env) };
    const must = async (args, options) => {
      const result = await git(args, options);
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
        `+refs/heads/${head}:refs/remotes/origin/${head}`], authScrubbed);

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

      const resolution = await resolveConflicts({ cwd: dir, git, sourceHunks: settings.sourceHunks ?? 'push' });
      if (!resolution.resolved) {
        return done('needs-manual-review', { reason: resolution.reason, ...(resolution.file && { file: resolution.file }) });
      }

      const files = resolution.files.map(f => f.file);
      await must([
        'commit', '-q', '--no-verify',
        '-m', `Merge branch '${base}' into ${head}`,
        '-m', `Auto-resolved conflicts (newer change per hunk, both sides in test files): ${files.join(', ')}`
      ]);
      const mergeSha = (await must(['rev-parse', 'HEAD'])).trim();

      const gate = await this.runRegressionGate(dir, repoConfig, settings, timeoutMs);
      if (!gate.passed) {
        return done('needs-manual-review', { reason: gate.reason, output: gate.output, files });
      }

      // Tests run PR code with write access to the clone; only the exact commit
      // they ran against may be pushed. Untracked files (node_modules) are fine.
      const testedHead = await git(['rev-parse', 'HEAD'], untrusted);
      if (testedHead.code !== 0 || String(testedHead.stdout).trim() !== mergeSha) {
        return done('needs-manual-review', { reason: 'tests moved HEAD away from the merge commit', files });
      }
      for (const args of [['diff', '--quiet'], ['diff', '--cached', '--quiet']]) {
        if ((await git(args, untrusted)).code !== 0) {
          return done('needs-manual-review', { reason: 'tests modified tracked files', files });
        }
      }

      if (dryRun) {
        return done('would-fix', { reason: `resolved ${files.length} file(s); tests passed`, files });
      }

      // The authenticated push runs from a fresh repository whose config the
      // tested code never saw, and sends the pinned merge commit, not HEAD.
      // mkdtemp makes its path unpredictable and refuses an existing one, so
      // tested code cannot plant a repository there for init to reinitialize.
      const pushDir = fs.mkdtempSync(path.join(this.workRoot, 'sdg-push-'));
      this.activePushDir = pushDir;
      await must(['init', '-q', '--bare', pushDir], { ...untrusted, cwd: pushDir });
      await must(['push', '-q', pushDir, `${mergeSha}:refs/heads/${head}`], untrusted);

      // Checked after the untrusted push, which runs with the clone's config
      if (!isFreshPushConfig(await git(['config', '--file', path.join(pushDir, 'config'), '--name-only', '--list'],
        { ...untrusted, cwd: pushDir }))) {
        return done('needs-manual-review', { reason: 'push repository config tampered', files });
      }

      // Never forced: a rejected fast-forward means someone pushed meanwhile.
      // Command-line protocol overrides beat any config, so an insteadOf
      // rewrite cannot route the credentials through ext::, ssh, git or file
      // (file stays allowed only when the remote itself is a local path).
      const lockdown = PUSH_BLOCKED_PROTOCOLS
        .filter(protocol => !(protocol === 'file' && path.isAbsolute(url)))
        .flatMap(protocol => ['-c', `protocol.${protocol}.allow=never`]);
      const push = await git([...lockdown, 'push', '-q', url, `${mergeSha}:refs/heads/${head}`], { ...authScrubbed, cwd: pushDir });
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
      this.activeDir = null;
      fs.rmSync(root, { recursive: true, force: true });
      if (this.activePushDir) {
        fs.rmSync(this.activePushDir, { recursive: true, force: true });
        this.activePushDir = null;
      }
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
