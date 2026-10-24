# Babysit: auto-address review comments

`sure-daily-github babysit` watches open pull requests that carry a label
(default `babysit`). For each one it reads every review comment, has an AI
engine triage them, implements and tests the fixes, pushes them to the PR
branch, and replies on every comment thread. Bot reviewers are tagged back
for a re-review.

**It never merges, approves, or closes anything.**

## Usage

```bash
sure-daily-github babysit                         # one scan of every enabled repository
sure-daily-github babysit --repo me/app           # only this repository (repeatable)
sure-daily-github babysit --repo me/app --pr 42   # only this pull request
sure-daily-github babysit --dry-run               # triage and print the plan; change nothing
```

`--once` is accepted and is the default: each invocation is a single scan.
The command exits `1` when the scan errored or any comment failed during this
run. Otherwise it exits `0`, including when another run held the lock and the
scan was skipped.

To scan on a schedule, set `babysit.enabled: true`. Each scheduler tick then
runs a babysit scan after the regular commit/issue execution, on the same cron.

## Configuration

```yaml
babysit:
  enabled: false              # scheduler opt-in (the CLI command works regardless)
  label: babysit              # label that marks a PR for babysitting
  engine: opencode            # opencode | claude
  model: openai/gpt-6.1-sol   # engine model
  ownPRsOnly: true            # only PRs authored by the token's user
  maxPrsPerRun: 5             # across all repositories, round-robin across runs
  testTimeoutMinutes: 15      # test gate timeout
  engineTimeoutMinutes: 30    # per engine invocation

repositories:
  - owner: me
    repo: app
    testCommand: "npm ci && npm test"   # optional; runs via sh -c
```

Only configured, enabled repositories are scanned. `--repo` must name one of
them, and other repositories are never queried.

### Engines

| `engine`   | Command run in the PR checkout (prompt on stdin) |
|------------|--------------------------------|
| `opencode` | `opencode run --auto --model <model>` with `OPENCODE_CONFIG_CONTENT=<policy>` and `OPENCODE_DISABLE_PROJECT_CONFIG=1` |
| `claude`   | `claude --model <model> -p --permission-mode dontAsk --setting-sources user --strict-mcp-config --allowedTools … --disallowedTools …` |

Commands are spawned with an argument array and no shell. The prompt, which
embeds untrusted review text, goes to the engine's **stdin**, never into argv,
so it cannot be read as shell syntax or hit the OS argument-size limit
(`E2BIG`). Comments are also **batched**: one engine call gets at most about
100,000 characters of comment bodies (a comment is never split from its id),
and large reviews take several calls whose results are merged.

The engine may run the PR's code (its tests), so it and the test gate run with
an allowlisted environment only (`PATH`, `HOME`, `TMPDIR`, `TZ`, `LANG`,
`LC_*`, `CI`): `GITHUB_TOKEN`, cloud credentials, and provider API key
variables are not passed. Each engine must find its credentials through its
own config under `HOME` (for example `opencode auth login` or `claude` login).

### Engine permission policy

The prompt tells the engine not to push or touch git config, but review text
is untrusted, so the boundary is **enforced by the engine's own permission
system**, not by the prompt:

- **opencode.** The policy is passed as inline config. bash is allowed except
  for an explicit deny list, and opencode never auto-approves a denied
  command, even with `--auto`. Rules are evaluated last match wins, so the
  catch-all `*` comes first. Denied:
  - `git push/pull/fetch/remote/clone/submodule/config/credential`
  - `gh`
  - network tools: `curl`, `wget`, `ssh`, `scp`, `sftp`, `rsync`, `nc`,
    `ncat`, `socat`, `telnet`, `ftp`
  - `sudo`
  - bypass forms: `git -c/-C/--git-dir/--work-tree/...`, `*/git …`, `env`,
    `eval`, `exec`, `command`, `xargs`, `bash/sh/zsh -c`

  `edit` is allowed, `external_directory` is denied (edits and reads stay in
  the checkout), and `webfetch` and `websearch` are denied.
  `OPENCODE_DISABLE_PROJECT_CONFIG=1` makes opencode ignore the PR's own
  `opencode.json` and `.opencode/` (agents, plugins, permission rules), which
  could otherwise re-order or widen the policy.
- **claude.** `dontAsk` mode allows only what is listed in `--allowedTools`
  and refuses everything else without a prompt. The allowed tools are
  `Read`, `Glob`, `Grep`, `Edit`, `Write`, `TodoWrite`, and local git
  (`status`, `diff`, `log`, `show`, `add`, `commit`). `--disallowedTools`
  additionally denies push, pull, fetch, remote, clone, config, `gh`, the
  network tools, `WebFetch`, and `WebSearch`. `--setting-sources user` and
  `--strict-mcp-config` ignore the PR's `.claude/settings.json` (permissions,
  hooks) and `.mcp.json`.
- **Both engines.** On top of the scrubbed environment, the engine gets:
  - `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_NOSYSTEM=1`: no global or
    system credential helpers or `insteadOf` rules
  - `credential.helper` reset, so a helper planted in the clone's
    `.git/config` cannot read `~/.git-credentials`
  - the `ssh`, `ext`, and `git` protocols set to `never`, plus
    `GIT_SSH_COMMAND=false`
  - `GH_CONFIG_DIR=/dev/null`

  So even a command the policy misses finds no git or `gh` credential under
  `HOME`.

**Residual risk.** opencode's bash policy matches command prefixes. It allows
arbitrary interpreters (`node -e`, `python -c`, `npm run`), which the engine
needs to run the PR's tests, and those can still open network connections or
read files under `HOME` (for example `~/.ssh` keys) directly. The environment
lockdown removes the git and `gh` credentials those programs would normally
pick up, and the engine never has the GitHub token. Full isolation of
arbitrary PR code needs an OS sandbox (container or dedicated user), which is
outside babysit. claude does not have this gap: Bash is limited to the
allowlist. In short, the enforceable boundary covers git, `gh`, and network
(egress) commands plus directories outside the checkout; closing the
interpreter gap completely requires running the engine in a container.

## How a pull request is handled

1. **Scan.** Lists open issues with the label in each repository and keeps the
   pull requests. With `ownPRsOnly`, it keeps only those authored by the
   token's user. Drafts are handled like any other PR. Closed PRs are skipped.
   A PR whose head branch is in a fork cannot be pushed to, so it gets one
   comment explaining that and is skipped from then on. When there are more
   candidates than `maxPrsPerRun`, the scan goes **round-robin**: it starts
   right after the last PR the previous scan visited (the cursor is stored in
   the ledger), so idle or fork PRs early in the list cannot starve the rest.
   Candidates are ordered by the configured repository order, so full and
   `--repo`/`--pr` scans share the one cursor; a cursor outside the selected
   repositories starts the scan at its first candidate. Before scanning,
   earlier pushes are reconciled and replies left pending by earlier runs are
   delivered (see [Reply delivery](#reply-delivery)).
2. **Collect.** Fetches inline review comments, review bodies, and issue
   comments. Babysit skips its own replies (they carry a hidden
   `<!-- sdg-babysit -->` marker), comments by the token's user, empty review
   bodies, and comments already in the ledger.
3. **Checkout.** Clones the PR head into a temporary directory and checks out
   the exact head SHA. Git hooks are disabled for every git call there,
   including commits the engine makes.
4. **Triage.** The engine gets the comments plus the PR diff and must write
   `{"comments":[{"id","action","reasoning","plan"}]}` to a JSON file. Its
   stdout is never parsed. Each comment gets one action: `fix`, `defer`,
   `wontfix`, or `note`. Anything the engine changed during triage is
   discarded.
5. **Implement** (only if there are `fix` items). The engine applies the
   fixes, adds tests, and commits with conventional messages. If it leaves
   uncommitted edits, babysit commits them as
   `fix: address review feedback on #N`. The engine must write a report with
   an explicit `status` (`implemented` or `failed`) for **every** item. Only
   `implemented` items are settled once the push succeeds. A `failed` item
   is charged an attempt. An item the report leaves out, or lists twice with
   conflicting statuses, stays pending without being charged. A missing or
   invalid report is treated as an infrastructure failure: nothing is pushed,
   settled, or charged. When comments are split into several engine calls, a
   failed call only affects its own items (charged when the engine failed,
   uncharged when it could not be started or wrote no report); the other
   calls' results are kept.
6. **Verify.** The new commits must descend linearly from the PR head (no
   rewritten history, no merges). `Co-Authored-By` and `Generated with` lines
   are stripped from their messages, keeping authors and trees. The working
   tree must be clean. Then the **test gate** runs: `testCommand`, or a command
   detected the same way as `fix-conflicts` (`npm test` after installing
   from the npm, pnpm or yarn lockfile, or a `Makefile` `test` target). If no test
   command can be found, nothing is pushed. Set `testCommand: "true"` to opt a
   repository out deliberately. Afterwards HEAD must still be the tested
   commit and tracked files unmodified.
7. **Push.** Pushes the tested SHA (not HEAD) to the PR branch from a fresh
   bare repository the PR code never touched, with the `ext`, `ssh`, `git`,
   and `file` protocols disabled. It is a plain push, which only
   fast-forwards: it never force-pushes, and if the branch moved in the
   meantime the push is rejected. A push rejected as `non-fast-forward` or
   `fetch first` lost a race and is not the comment's fault, so it is
   rescheduled: the comment stays pending, without being charged an attempt,
   and is handled against the new head on the next run. Any other rejection
   (a declined hook, a protected branch) is a failure that uses an attempt.
8. **Reply.** Each inline thread gets one reply:
   - `fix`: the commit SHA, what changed, the `file:line` locations, and a
     re-review request
   - `defer`: the reasoning and where the follow-up belongs
   - `wontfix`: the reasoning and evidence for declining
   - `note`: an acknowledgement and an optional pointer

   Review bodies and issue comments cannot be replied to individually, so
   they share one summary PR comment that lists each disposition. Bot authors
   (`user.type == "Bot"`) are mentioned (`@coderabbitai`, with `[bot]`
   removed). A bot is asked to re-review only when this run pushed a commit,
   and only once per pushed head, even if it opened several threads. Humans
   are never mentioned.

## Reply delivery

Deciding an outcome and delivering its reply are separate steps:

1. As soon as the push succeeds, before any reply is sent, every outcome and
   every reply body is written to the ledger in one save. Pushed fixes are
   recorded as `pushed` with the commit SHA.
2. Each reply is posted, and its comments are settled when the post succeeds.
3. If a post fails, its comments settle with `replyPending` (a pushed fix
   becomes `addressed`), and the reply stays queued.

Each later run first retries queued replies. It only posts them and never
runs the engine again. A `pushed` entry (the process died between the push
and the reply) is delivered only if the PR head is still the pushed SHA. If
the branch has moved on, the comment is settled as `addressed` with a note
and no reply is sent. If the PR lookup itself fails (for example a `503`),
the reply stays queued without using a delivery attempt; a `404` drops it
with a note. Give-up notices are queued and retried the same way. A reply
that fails to post 10 times is dropped with a note.

Right before the push, a **push intent** is saved: the expected pushed SHA,
the source head, and every outcome and reply the push would settle. It is
removed in the same save that records the outcomes. If the run dies or is
interrupted in between, the next run checks the PR first: if its head is the
expected SHA, the push landed, so the stored outcomes are recorded and their
replies delivered without running the engine again. Otherwise the push never
landed and the comments stay pending. While the PR lookup fails, the intent
is kept and the PR is not processed.

## Interrupts

On `SIGINT`/`SIGTERM`, babysit:

1. Kills the engine and test process groups, including grandchildren (SIGTERM,
   then SIGKILL after a grace period).
2. Marks the interruption on the PR in the ledger. The interrupted PR's
   comments were not charged an attempt.
3. Removes the temporary clone and push repository.
4. Releases the run lock.
5. Exits `130` (`SIGINT`) or `143` (`SIGTERM`).

A second signal is ignored. Nothing is pushed after the interrupt, and
replies for an already pushed fix stay queued in the ledger (or in its push
intent, when the interrupt came right after the push). Process groups stay
tracked until every member has exited, so a background grandchild outliving
its group leader is still killed.

## Per-comment memory (ledger)

`data/babysitter-state.json` (override with `SDG_BABYSITTER_STATE_FILE`)
records each comment, keyed by repository, PR, and comment id. Each entry
holds its state, the PR head SHA at handling time, the action, the reply id,
and the commit SHA. Writes are atomic (write, then rename). A corrupt file is
backed up to `.bak` and the ledger starts fresh.

| State       | Meaning | Reprocessed? |
|-------------|---------|--------------|
| `pushed`    | fix pushed, reply not yet attempted | never; only the reply is delivered |
| `addressed` | fix pushed (and replied, unless `replyPending`) | never |
| `deferred`  | deferral reasoning decided (and replied, unless `replyPending`) | never |
| `wontfix`   | declined with evidence (and replied, unless `replyPending`) | never |
| `noted`     | acknowledged (and replied, unless `replyPending`) | never |
| `failed`    | triage, the engine (exit or timeout), tests, or a reported `failed` fix | retried once more; after 2 failures the thread gets a "leaving this for manual follow-up" reply and is left alone |

Queued replies live under `deliveries`, unreconciled pushes under
`pushIntents`, and the round-robin position under `cursor`. Some failures are not charged against a comment and leave it
pending: an engine that cannot be spawned (`E2BIG`, `ENOENT`, `EACCES`), a
missing or invalid implement report, an item the report left out, a push
rejected because the branch moved, and an interrupt. A failure in the
current run (except a rescheduled push) makes the command exit `1`.

## Safety model

- **Never merges.** Babysit only pushes commits and posts comments.
- **Pinned-SHA, fast-forward-only push.** Only the exact SHA that passed the
  test gate is pushed, with a non-force push.
- **Test gate.** Nothing is pushed unless the tests pass within
  `testTimeoutMinutes`.
- **No attribution.** Commit messages are checked and cleaned before the push.
- **Hooks disabled.** Every git call sets `core.hooksPath` to the null device
  on the command line, which beats anything written to the clone's config.
- **Token handling.** Git authenticates with an environment-only HTTP header,
  used only for the initial fetch (before any PR code runs) and the final
  push from the fresh repository. The token is never in a URL, in
  `.git/config`, or in the environment of the engine, the tests, or any git
  call that reads the clone's (untrusted) config.
- **Shared run lock.** Babysit uses the same lock as `run` and the scheduler.
  If another process holds it, the scan is skipped.
- **Untrusted input.** Review comments are passed to the engine as stdin
  data, and the engine's enforced permission policy (see
  [Engine permission policy](#engine-permission-policy)) keeps them from
  reaching push, `gh`, network, or credential tools. The PR's code
  (its tests) runs on your machine. Keep `ownPRsOnly: true` unless you trust
  every author who can push a labeled branch to the repository.
