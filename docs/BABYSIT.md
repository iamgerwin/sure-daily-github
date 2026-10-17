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
  maxPrsPerRun: 5             # across all repositories
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

| `engine`   | Command run in the PR checkout |
|------------|--------------------------------|
| `opencode` | `opencode run --auto --model <model> <prompt>` |
| `claude`   | `claude --model <model> -p <prompt> --permission-mode acceptEdits` |

Commands are spawned with an argument array and no shell, so review text in
the prompt cannot be interpreted as shell syntax. The engine may run the PR's
code (its tests), so it and the test gate run with an allowlisted environment
only (`PATH`, `HOME`, `TMPDIR`, `TZ`, `LANG`, `LC_*`, `CI`): `GITHUB_TOKEN`,
cloud credentials, and provider API key variables are not passed. Each engine
must find its credentials through its own config under `HOME` (for example
`opencode auth login` or `claude` login).

## How a pull request is handled

1. **Scan.** Lists open issues with the label in each repository and keeps the
   pull requests. With `ownPRsOnly`, it keeps only those authored by the
   token's user. Drafts are handled like any other PR. Closed PRs are skipped.
   A PR whose head branch is in a fork cannot be pushed to, so it gets one
   comment explaining that and is skipped from then on.
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
   uncommitted edits (for example, `claude` in `acceptEdits` mode cannot run
   git), babysit commits them as `fix: address review feedback on #N`.
6. **Verify.** The new commits must descend linearly from the PR head (no
   rewritten history, no merges). `Co-Authored-By` and `Generated with` lines
   are stripped from their messages, keeping authors and trees. The working
   tree must be clean. Then the **test gate** runs: `testCommand`, or a command
   detected the same way as `fix-conflicts` (`npm test` after `npm ci` when a
   `package-lock.json` exists, or a `Makefile` `test` target). If no test
   command can be found, nothing is pushed. Set `testCommand: "true"` to opt a
   repository out deliberately. Afterwards HEAD must still be the tested
   commit and tracked files unmodified.
7. **Push.** Pushes the tested SHA (not HEAD) to the PR branch from a fresh
   bare repository the PR code never touched, with the `ext`, `ssh`, `git`,
   and `file` protocols disabled. It is a plain push, which only
   fast-forwards: it never force-pushes, and if the branch moved in the
   meantime the push is rejected.
8. **Reply.** Each inline thread gets one reply:
   - `fix`: the commit SHA, what changed, the `file:line` locations, and a
     re-review request
   - `defer`: the reasoning and where the follow-up belongs
   - `wontfix`: the reasoning and evidence for declining
   - `note`: an acknowledgement and an optional pointer

   Review bodies and issue comments cannot be replied to individually, so
   they share one summary PR comment that lists each disposition. Bot authors
   (`user.type == "Bot"`) are mentioned (`@coderabbitai`, with `[bot]`
   removed) with an explicit re-review request. Humans are never mentioned.

## Per-comment memory (ledger)

`data/babysitter-state.json` (override with `SDG_BABYSITTER_STATE_FILE`)
records each comment, keyed by repository, PR, and comment id. Each entry
holds its state, the PR head SHA at handling time, the action, the reply id,
and the commit SHA. Writes are atomic (write, then rename). A corrupt file is
backed up to `.bak` and the ledger starts fresh.

| State       | Meaning | Reprocessed? |
|-------------|---------|--------------|
| `addressed` | fix pushed and replied | never |
| `deferred`  | replied with the deferral reasoning | never |
| `wontfix`   | replied declining, with evidence | never |
| `noted`     | acknowledged once | never |
| `failed`    | triage, engine, tests, or reply failed | retried once more; after 2 failures the thread gets a "leaving this for manual follow-up" reply and is left alone |

A failure in the current run makes the command exit `1`.

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
- **Untrusted input.** Review comments are passed to the engine as data, and
  the prompts tell it not to follow instructions inside them. The PR's code
  (its tests) runs on your machine. Keep `ownPRsOnly: true` unless you trust
  every author who can push a labeled branch to the repository.
