# Conflict Fixer (`fix-conflicts`)

## Goal

Make conflicted open pull requests mergeable again across the configured repositories without a human doing the merge. For each conflicted PR, the base branch is merged into the PR branch and every conflicting hunk keeps the newer change, except in test files, where both sides are kept. The result is pushed only if the repository's own tests pass, so no regression is ever pushed automatically, and nothing is touched on a repository that was not explicitly approved.

## Safety model

A resolved branch is pushed only when **every** check below passes. Otherwise the PR is reported and left alone.

Never auto-pushed:

- **Ties**: both sides of a hunk were committed at the same second.
- **Test hunks that change existing lines**: a test-file hunk where either side modified or removed a base line, not only added lines (see [Test files](#test-files)).
- **Test-count drops**: a resolved test file with fewer tests than either parent's version.
- **Source hunks under `sourceHunks: escalate` or `claude`**: any conflict outside a test file.
- **Non-text conflicts**: delete/modify, rename, binary, submodule or symlink conflicts. Also hunks that cannot be located unambiguously, and resolutions that still contain conflict markers.
- **No tests**: no `testCommand`, no usable `npm test` script, and no `test` rule in the makefile `make` would read (the first of `GNUmakefile`, `makefile`, `Makefile`; `test := ...` variables do not count).
- **Test failures**: dependency install or test failure, or a timeout (`testTimeoutMinutes`).
- **Tampering tests**: the tests moved `HEAD` (for example by committing) or left changes to tracked files. Untracked files such as `node_modules` are fine.
- **Fork PRs**: the head lives in another repository. Fork PRs are also never tested, because tests run PR-branch code.
- **Dry runs**: `--dry-run` or `general.dryRun: true`.
- **Non-fast-forward rejections**: pushes are never forced. If the branch moved, the push is rejected and reported as `head-moved`.
- **Repo gate**: repositories that are not allowed (see below). The default is an empty allowlist, so nothing is fixed until you opt in.

Other guarantees:

- Each run uses throwaway clones in the OS temp directory, which are deleted afterwards.
- Your global and system git config (hooks, signing, merge drivers) is ignored, and every git command runs with `core.hooksPath` pointed at the null device on the command line, so hooks planted by the tested code never run.
- The GitHub token never appears in URLs, `.git/config`, the process list or logs. Tests run with only `PATH`, `HOME`, `TMPDIR`, `TZ`, `LANG`, `LC_*` and `CI=true` in their environment; every other variable (tokens, cloud credentials) is dropped.
- After the tests have run, the clone's config is no longer trusted: the authenticated push is made from a fresh repository that receives only the pinned merge commit.

## Repo gating

The gate is evaluated per repository. The **first** matching rule decides:

| # | Rule | Result |
|---|------|--------|
| 1 | `repositories[].conflictFixer: false` | skipped, `disabled-per-repo` |
| 2 | `repositories[].conflictFixer: true` | allowed (wins over both lists and the mode) |
| 3 | repo is in `denylist` | skipped, `denylisted` |
| 4 | `mode: allowlist` and repo is not in `allowlist` | skipped, `not-allowlisted` |
| 5 | `mode: denylist` or `mode: all` | allowed |

- List entries are `owner/repo` and are matched case-insensitively.
- Gated-out repositories are never queried, so they cost no API calls.
- `--repo` only narrows the run. It never bypasses the gate: a gated repo passed via `--repo` is shown as a `skipped` row with its reason, and so is every gated repo in `--scan-only` output.

**Allowlist (default, opt-in):**

```yaml
conflictFixer:
  mode: "allowlist"
  allowlist:
    - "yourusername/web"
    - "yourusername/api"
```

**Denylist (every configured repo except these):**

```yaml
conflictFixer:
  mode: "denylist"
  denylist:
    - "yourusername/legacy-repo"
```

**All (every configured repo; the denylist still applies):**

```yaml
conflictFixer:
  mode: "all"
  denylist:
    - "yourusername/legacy-repo"
```

**Per-repo override (beats mode and both lists):**

```yaml
repositories:
  - owner: "yourusername"
    repo: "api"
    conflictFixer: true     # always eligible
  - owner: "yourusername"
    repo: "docs"
    conflictFixer: false    # never touched
```

With no `conflictFixer` block at all, the mode is `allowlist` and the allowlist is empty, so **nothing is fixed**.

## How a PR is fixed

1. List open PRs through GraphQL, including `mergeable` and `mergeStateStatus`. A PR is conflicted when it is `CONFLICTING` or `DIRTY`.
2. Fetch the base and head branches into a temp repo. Continue only if the head is still at the SHA GitHub reported.
3. Run `git merge --no-ff --no-commit` with `merge.conflictStyle=diff3`. A clean merge means GitHub's status was stale (`stale-status`).
4. For each conflicting hunk in a source file, find its lines on both sides and take the newest `git blame` committer time for each. The newer side wins. If one side deleted the hunk, that side's newest commit to the file since the merge base is used instead. With `sourceHunks` set to anything but `push`, the PR is left for review instead. Test-file hunks are merged as described in [Test files](#test-files).
5. Commit the merge: `Merge branch '<base>' into <head>`, and pin its SHA.
6. Run the regression gate: the repo's `testCommand`, else `npm test`, else `make test`. When `installDeps` is on, dependencies are installed first, including before a `testCommand`: `npm ci` for `package-lock.json` or `npm-shrinkwrap.json`, else `pnpm install --frozen-lockfile` for `pnpm-lock.yaml`, else `yarn install --frozen-lockfile` for `yarn.lock`, else `bun install --frozen-lockfile` for `bun.lock` or `bun.lockb`. The matching package manager must be on `PATH`.
7. Check that `HEAD` is still the pinned merge commit and that tracked files are unchanged.
8. Push `<merge SHA>:refs/heads/<head>` without force.

## Test files

Newer-wins on a test file silently drops the tests the older side added, and the test gate cannot notice tests that are no longer there. Conflicts in test files are therefore merged as a union instead.

- **Test files** are paths matching `test/**`, `__tests__/**` (both from the repository root), `**/*.test.js` or `**/*.spec.js`.
- **Union**: every line either side added is kept. The base lines stay in place, and at each insertion point the PR branch's (ours) additions come first, then the base branch's (theirs). If both sides added the identical lines at the same point, they are kept once.
- **Escalation**: if either side modified or removed a base line inside the conflict region, the union could resurrect or duplicate code, so the PR is left for review (`needs-manual-review`, with the path in the result's `file`).
- **Test-count check**: after a test file is resolved, the number of `test(...)`/`it(...)` calls (including `.only`, `.skip` and `.todo`) at the start of a line must be at least the larger count of the two parents' versions of that file. Otherwise the PR is left for review. The check lives in the resolver (`src/core/conflict-resolver.js`), per conflicted test file, before the file is staged, so nothing reaches the commit or the push without it. It is deliberately strict: when one side cleanly deleted tests elsewhere in the same file, the count drops and a human decides.

## Source hunks

`conflictFixer.sourceHunks` decides what happens to conflicts outside test files:

| Value | Behaviour |
|-------|-----------|
| `push` (default) | Newer change wins and the result is pushed after the test gate, as before |
| `claude` | Reserved for the PR-maintenance automation, which resolves source hunks with a verified Claude worker. `fix-conflicts` on its own leaves the PR for review |
| `escalate` | The PR is left for review (`needs-manual-review`) |

## Idempotency

Four layers stop overlapping or repeated work:

1. **Run lock**: shared with `run` and the scheduler (`data/run.lock`). A second invocation exits at once with a lock-held error and does no work.
2. **Head SHA pinning**: work is tied to the head SHA captured during the scan, and the push is fast-forward only. If someone else fixed the PR first, the push is rejected (`head-moved`) and not retried.
3. **Attempt ledger**: `data/conflict-fixer-state.json`, overridable with `SDG_CONFLICT_FIXER_STATE_FILE`. It stores one entry per `owner/repo#number` with `headSha`, `status`, `startedAt` and `finishedAt`, written atomically before and after each attempt. Before cloning, a PR is skipped when:
   - its entry is `in-progress` on the same SHA and younger than `attemptTtlMinutes` (default 60): reason `already-in-progress`;
   - its entry is finished (`fixed`, `needs-manual-review` or `failed`) on the same SHA and within `retryCooldownMinutes` (default 240): reason `already-attempted`.

   A different head SHA, or an expired TTL or cooldown, makes the PR eligible again. `--scan-only` and dry runs never write the ledger. Outcomes that are not attempts (`stale-status`, `head-moved`) remove the entry.
4. **Signals**: on SIGINT or SIGTERM, a running install or test command is killed with its whole process group, this run's in-progress entries are marked `interrupted`, the current temp clone is removed, and the process exits with 130 (SIGINT) or 143 (SIGTERM). Interrupted attempts are eligible on the next run.

Long test suites hold the run lock for the whole run. Raise `SDG_RUN_LOCK_STALE_MS` (default 2 hours) if a full pass can take longer.

## Scan budget

`conflictFixer.scanTimeoutSeconds` (default 120), or `--scan-timeout <seconds>` for a single run, caps the whole gather phase: GraphQL pagination over every allowed repo plus the re-polls for `UNKNOWN` mergeability.

- The budget is checked before each repo, before each further page, and before each re-poll. A re-poll is skipped when the remaining budget is shorter than its 2 s sleep.
- When the budget runs out, scanning stops. PRs already collected are still processed normally, including those from the pages already fetched for a repo cut off mid-pagination. Every repo that was not fully listed also gets one `scan-timeout` row with reason `scan budget exhausted`, after its PR rows.
- `scan-timeout` does not cause a non-zero exit.

## Configuration

```yaml
conflictFixer:
  mode: "allowlist"          # allowlist | denylist | all
  allowlist: ["yourusername/web"]
  denylist: []
  testTimeoutMinutes: 15     # per install/test command
  installDeps: true          # install from the npm, pnpm, yarn or bun lockfile first
  scanTimeoutSeconds: 120
  attemptTtlMinutes: 60
  retryCooldownMinutes: 240
  sourceHunks: "push"        # push | claude | escalate

repositories:
  - owner: "yourusername"
    repo: "web"
    testCommand: "npm run test:unit"   # optional; overrides detection
    conflictFixer: true                # optional per-repo gate override
```

All numbers must be positive whole numbers and `sourceHunks` must be `push`, `claude` or `escalate`. Invalid values fail `validate` and config loading.

## CLI reference

```
sure-daily-github fix-conflicts [options]
```

| Flag | Description |
|------|-------------|
| `--dry-run` | Resolve and test locally, but never push or write the ledger |
| `--scan-only` | Only list conflicted PRs and gated-out repos; nothing is cloned |
| `--repo <owner/repo>` | Only process this configured repository (repeatable; a repository named twice is processed once); filter only, never bypasses the gate |
| `--pr <number>` | Only process this PR (a positive integer; requires exactly one `--repo`) |
| `--scan-timeout <seconds>` | Gather-phase budget for this run (overrides `scanTimeoutSeconds`) |
| `--config <path>` | Path to the configuration file |

Examples:

```bash
# See what is conflicted and which repos are gated out
sure-daily-github fix-conflicts --scan-only

# Rehearse on one repository without pushing
sure-daily-github fix-conflicts --repo yourusername/web --dry-run

# Fix a single PR
sure-daily-github fix-conflicts --repo yourusername/web --pr 42

# Give a slow organisation more scan time
sure-daily-github fix-conflicts --scan-timeout 300
```

## Result statuses

| Status | Meaning | Exit code |
|--------|---------|-----------|
| `fixed` | Conflicts resolved, tests passed, branch pushed | 0 |
| `would-fix` | Same as `fixed`, but a dry run, so nothing was pushed | 0 |
| `conflicted` | Listed by `--scan-only` | 0 |
| `needs-manual-review` | Tie, non-text conflict, test hunk that changes existing lines, test-count drop, source hunk under `sourceHunks: escalate`/`claude`, unlocatable hunk, leftover markers, no test command, install or test failure, timeout, or tests that moved `HEAD` or changed tracked files | 0 |
| `skipped` | Reasons: `disabled-per-repo`, `denylisted`, `not-allowlisted`, `fork pull request`, `already-in-progress`, `already-attempted` | 0 |
| `stale-status` | Merges cleanly locally; GitHub's mergeability was out of date | 0 |
| `head-moved` | Branch changed after the scan or before the push; nothing was pushed | 0 |
| `scan-timeout` | Repo not fully listed within the scan budget | 0 |
| `unknown` | GitHub still reported `UNKNOWN` mergeability after the re-polls | 0 |
| `error` | Listing failed, the temp work directory could not be created, or an unexpected git error occurred | **1** |

The command also exits 1 when the run itself fails: a held lock, a configuration error, an invalid `--scan-timeout`, or a bad `--repo` or `--pr` value.

## Cost

The fixer runs only `git` and the target repository's own install and test commands, plus GitHub API calls for listing. It makes no LLM or other paid API calls. The opt-in repo gate makes sure neither compute nor any future automation built on this command spends anything on repositories you have not approved.
