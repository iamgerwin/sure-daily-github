# Software Factory Blueprint

This document describes the autonomous pull-request pipeline that runs around
this repository, and how to reuse it on another project. It covers design,
guards, and lessons learned. It does not describe the `sure-daily-github`
product itself; for that, see the repository `README.md` and `docs/`.

Related sources:

| Source | Role |
|---|---|
| `$H/.hermes/scripts/sdg-*.sh`, `claude-watchdog.sh`, `lib-quota.sh`, `claude-quota.sh` | The pipeline. Ground truth when this document and the code disagree. |
| `$H/.hermes/skills/devops/auto-pr-pipeline/SKILL.md` | Operational runbook: manual procedures, pitfalls, recovery steps. |
| `docs/LABELS.md` | Canonical label scheme: names, colors, descriptions, and `gh` bootstrap commands. |
| `blueprint/LABELS.md` | Label states and workflow: owner of every label in all four families, which routine sets and removes each `status/*` label, the full transition table with triggers and guards, and the `quality/*` contract. |
| `.claude/skills/create-pr/SKILL.md` | Branch name, PR title and PR description template. |

`$H` is the Hermes home on the host (`<hermes-home>`). Concrete host paths
are kept in the private runbook, not in this document.
All times are Asia/Manila (PHT).

---

## 1. What this is

### Definition

In this document, a **software factory** is a pipeline in which code changes
are created, reviewed, repaired, and re-reviewed by automation, and a person
makes only the merge decision:

```
create -> review -> self-heal -> re-review -> human merge
```

### Fit assessment

The pipeline is a working proof of concept of that definition. It has run
unattended on a schedule since 2026-10-14. As of 2026-10-25, the creation
log records 73 successful creation cycles.

What earns the term:

- **Unattended production.** Cron produces 3 to 10 pull requests a day.
  Each PR is planned, implemented, tested, pushed, and opened by an engine
  without a person starting it.
- **Uniform output.** Branch names, PR titles, PR description sections, and
  labels follow fixed templates. Every PR has the same shape and can be
  processed by the next stage without special cases.
- **Closed repair loops for the two most common failures.** When a PR stops
  merging cleanly because its base branch moved, the pipeline detects it,
  repairs it, runs mechanical checks on the pushed result, and sends it back
  for another review. Those checks do not include the test suite (see the
  conflict test gate limit below). When a review scores a PR below the
  score gate (8 of 10), a fix-round job addresses the findings, runs the
  test suite itself, pushes only if it passes, and sends the PR back for
  another review, up to a per-PR lifetime round budget. No person is
  involved in either loop.
- **Throttles on every producer.** A daily plan, a cooldown, a backlog gate,
  a circuit breaker, review budgets, and fix-round budgets keep output and
  spending bounded.
- **Toolchain self-maintenance.** A watchdog repairs the engine toolchain
  after host updates remove it.

What is still proof-of-concept grade:

| Limit | Detail |
|---|---|
| Single repository | Every script hardcodes one repository slug, one local clone, and one worktree path per job (conflict repair, fix rounds). |
| Single assignee | The conflict checker selects PRs assigned to one user. The creation prompt assigns every PR to that user. Review and fix rounds select by head branch (`auto-pr/*`), not by assignee. |
| Hardcoded names | Host paths, the repository, the assignee, the commit identity for script-made commits, the base branch for creation (`master`), and the proxy port are literals. A few values have environment overrides. |
| GitHub-specific | State lives in GitHub labels and comments. Detection relies on GitHub's `mergeable` field. All I/O goes through the `gh` CLI. |
| Human merge gate | This is intentional. It also caps throughput at the owner's review bandwidth, which is why the backlog gate exists. |
| Conflict test gate is not enforced by the script | A clean merge is pushed without running the test suite. A conflicted merge depends on the engine following its instruction to run `npm test`. The orchestrator verifies that the push landed, that no conflict markers or attribution remain, and that GitHub reports the PR as mergeable. It does not run the tests or check their results. The live `status/conflict-resolved` label description, the PR comment, `docs/LABELS.md` (status table and bootstrap), and the bootstrap snippet in section 6 claim only what is verified ("branch merged with base"). One place in the code still overstates it: the patrol's channel notification ("conflict auto-resolved, tests green"). |
| Review gates automation, not merging | Findings are filtered to files the PR changed. They are not checked line by line, and the reviewer does not run the tests. The score decides only whether the automation runs another fix round. It never merges and never blocks the owner from merging. |
| Status labels can still coexist during conflict repair | The review, push-detection, and fix-round transitions remove stale lifecycle labels. Conflict repair does so only in part. Phase 0 removes `status/awaiting-ai-review` when it adds `status/conflict`, but leaves a `status/ai-reviewed` or `status/fix-round` in place. Phase 2 adds `status/awaiting-ai-review` without removing that leftover. A leftover `status/ai-reviewed` is cleaned up by the next review transition. A leftover `status/fix-round` deadlocks the PR (section 3). Section 3 defines the precedence rule for reading coexisting labels. |
| Fix-round retries are bounded per day, not per lifetime | The per-PR round budget bounds how many reviews can send a PR into a fix round. A fix round that keeps failing verification is retried at most twice per PR per day, but on every day until it passes or a human acts. |
| CI is not consulted | No stage reads GitHub check runs. |
| Partial kill switches | Review and fix rounds have marker-file kill switches. Creation and conflict repair are stopped by disabling their cron entries. |
| Pipeline scripts have no test suite | Script changes are checked with hand-run fixtures. |
| Observability | Observability is limited to channel messages and per-script log files. There are no metrics. The fix-round attempt cap, the review day budget, and the reconciler each post one alert per stall. A PR stuck in a deferred state (5.8), at the conflict-repair attempt cap, or in the fix-round deadlock (section 3) still produces no notification. |
| Claude quota guard sees only this host | The proactive gauge reads only the Claude sessions on the VPS. The owner's laptop usage reaches the guard only through the reactive layer, after an automated run has already hit the limit (section 2). |

What separates it from production:

1. **An enforced test gate on every push path.** The fix-round job already
   has one: it runs `npm test` itself and pushes only if it passes. Creation
   and conflict repair do not. The product's own `fix-conflicts` command
   (`docs/CONFLICT_FIXER.md`) shows the pattern for conflict repair: it
   pushes only after the repository's tests pass, in an isolated clone, and
   never force-pushes.
2. **CI as the source of truth** for merge readiness, instead of an engine's
   report.
3. **One lifecycle label at a time, enforced by the orchestrator on every
   transition.** Review, push detection, and fix rounds already remove stale
   lifecycle labels. Conflict repair removes only `status/awaiting-ai-review`
   so far. The product's `pr-maint`
   command (`docs/PR_MAINTENANCE.md`) removes extra
   lifecycle labels and has a per-PR and global `automation-paused` kill
   switch. It uses its own `sdg:*` label namespace and is not yet wired into
   this pipeline.
4. **Configuration instead of literals**, so that more than one repository,
   assignee, or base branch can be supported.
5. **Tests for the pipeline itself**: fixture tests for every parse chain and
   for every state transition.
6. **Metrics**: PRs per day, review score distribution, conflict repair
   success rate, the rate at which the human overrides the review verdict,
   and time from creation to merge.
7. **An automated merge policy**, if it is ever wanted. The human gate is a
   deliberate choice in this pipeline, not a missing feature.

---

## 2. Architecture

### Jobs

The pipeline consists of five cron entries in the Hermes scheduler. All five
run as `no_agent` jobs: Hermes runs the script directly and delivers its
standard output to the configured destination.

| Schedule | Script | Purpose | Engine | Guards | Delivers to |
|---|---|---|---|---|---|
| `0,30 * * * *` | `sdg-autopr.sh` | Creates one PR per due slot. Claude Code plans, codes, tests, branches, commits, pushes, and opens the PR with labels `status/awaiting-ai-review` and `quality/low`. The script then checks the result and posts the notification. | Claude Code, `claude-opus-5-5`, under `headroom wrap`. Under a Claude quota block: `openai/gpt-6.1-sol` via OpenCode, without the proxy. | Deterministic daily plan (3 to 10 PRs), 40-minute cooldown, catch-up window closes at 22:30, backlog gate (more than 30 open `auto-pr/*` PRs pauses creation), circuit breaker (3 consecutive failed cycles stops creation for the day), 60 turns (Claude only), 30-minute timeout, run lock and repo lock, attribution audit after the cycle, Claude quota guard | Review channel |
| `5,35 * * * *` | `sdg-conflict-patrol.sh` | Phases 0 to 3. Phase 0 labels conflicting PRs `status/conflict` and removes `status/awaiting-ai-review`. Phase 1 frees the PR branch from any foreign worktree, then resolves the conflict. Phase 2 sends resolved PRs back for review. Phase 3, the label reconciler, gives every open `auto-pr/*` PR without a `status/*` label one back (`status/fix-round` if a findings file exists, otherwise `status/awaiting-ai-review`) and posts one alert per PR for a `status/fix-round` PR without a findings file. | `git merge` when the merge is clean. Otherwise Claude Code, `claude-opus-5-5`, under `headroom wrap`. Under a Claude quota block: `openai/gpt-6.1-sol` via OpenCode. | 2 attempts per PR per day, `UNKNOWN` mergeability deferred to the next tick, repo lock, worktree self-freeing, orchestrator verification, 40 turns (Claude only), 25-minute timeout, Claude quota guard | Review channel |
| `10,40 * * * *` | `sdg-fixround.sh` | Takes at most one `status/fix-round` PR per tick. Claude Code addresses every finding in `findings-<pr>.json` in a dedicated worktree, one commit per finding, and does not push. Before creating that worktree, the script force-removes any foreign worktree that holds the PR branch. The script verifies the result, runs `npm test` itself, pushes only if the tests pass, then changes the label to `status/awaiting-ai-review` and clears the review ledger. Findings whose reviewed head SHA no longer matches the PR head are stale: the PR is re-queued for review without an engine run. | Claude Code, `claude-opus-5-5`, called directly (no `headroom wrap`). Under a Claude quota block: `openai/gpt-6.1-sol` via OpenCode. Either way, `git push` is denied to the engine. | 4 engine runs per day (counted at dispatch), 2 attempts per PR per day (one alert per PR per day at the cap), 1 engine run per tick, repo lock, worktree self-freeing, `UNKNOWN` mergeability deferred, `CONFLICTING` PRs left to conflict repair, PRs also carrying another in-flight `status/*` label skipped, 40 turns (Claude only), 25-minute timeout, 10-minute orchestrator test run, kill switch, Claude quota guard | Review channel |
| `20,50 * * * *` | `sdg-autoreview.sh` | Phase 0 (push detection) re-queues `status/ai-reviewed` PRs whose head moved since their review. Then reviews each PR labeled `status/awaiting-ai-review` on an `auto-pr/*` branch that carries none of `status/conflict`, `status/conflict-resolved`, or `status/fix-round`, posts one scorecard comment, and applies the score gate: 8 or more goes to `status/ai-reviewed`; below 8 goes to `status/fix-round` with the findings saved; below 8 at round 10 goes to `status/ai-reviewed` with a "human review required" comment. A PR over the size cap of its quality tier is not reviewed: it gets a hand-off comment and `status/ai-reviewed` as the owner's cue. | Routed by quality tier, then size: `quality/high` gets `openai/gpt-6.1-sol#xhigh` (OpenCode); `quality/mid` gets `openai/gpt-6.1-sol` whatever the size; otherwise `claude-haiku-5-5` (`claude -p`) for 400 lines or fewer and `openai/gpt-6.1-sol` above. Under a Claude quota block, every Claude review runs on `openai/gpt-6.1-sol` instead. | One review per code state (the ledger records the reviewed head SHA), 20 reviews per day (one alert when spent), 2 per tick, tier line cap (800 default, 1,600 mid, 4,000 high), tier input cap (60,000, 100,000, 200,000 characters), per-PR lifetime round budget, kill switch, run lock, Claude quota guard on Claude reviews | Review channel |
| `25,55 * * * *` | `claude-watchdog.sh` | Repairs the toolchain: the node symlink, the `claude` CLI (reinstall, plus an update check at most every 20 hours), `headroom` with its proxy extras and launcher, and the `opencode` symlink. | None. Uses no tokens. | Silent when healthy | Owner's direct messages |

The jobs are staggered so that they rarely overlap. The watchdog runs five
minutes before each creation tick, so a broken toolchain is repaired before
the job that relies on it most. The fix-round job runs ten minutes before
each review tick: a fix round that finishes within ten minutes is
re-reviewed in the same half-hour, and a longer one at the next review
tick. Creation, conflict repair, and fix rounds share the repo lock
(below), so a long run of one makes the others skip their ticks.

### Score gate and round budget

The review computes a score from the findings it keeps: 10, minus 2 per
critical finding, minus 1 per warning, floored at 0. Suggestions do not
lower it. Every scored review appends its score to `rounds-<pr>`, so the
round number of a review is the count of earlier scored reviews plus one.

| Outcome | Condition | Label after the review | Side effects |
|---|---|---|---|
| Pass | Score at least `SDG_REVIEW_PASS_SCORE` (8) | `status/ai-reviewed` | `findings-<pr>.json` deleted |
| Fix | Score below 8 and round below `SDG_REVIEW_MAX_ROUNDS` (10) | `status/fix-round` | Findings, score, summary, round, and reviewed head SHA saved to `findings-<pr>.json` for the fix-round job |
| Cap | Score below 8 at round 10 or later | `status/ai-reviewed` | A second comment: "score-gate cap reached ... human review required" |

An engine output without a parsable findings list is a failed review, not a
pass. It takes the manual-review path (section 3). An earlier version scored
such output as "approve, 10/10".

The round budget is a per-PR lifetime budget. Automation never resets
`rounds-<pr>`: not on a fix-round push (the fix rounds are the loop being
bounded), not on a conflict repair (a mechanical base merge is not new
intent, and resetting would let a churning base branch reopen the loop
indefinitely), and not on push detection. Passing reviews and conflict
re-reviews also consume rounds. So at most 9 reviews per PR can ever send it
into a fix round. After the cap, each new code state still gets one review,
but a low score no longer re-enters the loop. Only a human grants a fresh
budget, by deleting `rounds-<pr>`.

### Engine routing

| Role | Engine and model | Input | Cost basis |
|---|---|---|---|
| Implementation | Claude Code, `claude-opus-5-5` | The whole repository. The engine explores, edits, and runs tests. | Subscription |
| Conflict resolution | Claude Code, `claude-opus-5-5` | Worktree with a merge in progress | Subscription. Runs only when `git merge` cannot finish on its own. |
| Fix round | Claude Code, `claude-opus-5-5`, 40 turns | Worktree on the PR branch, plus the saved findings JSON (up to 20,000 characters). The engine explores, edits, commits, and runs tests, but cannot push. | Subscription. Runs only for a PR the score gate sent to `status/fix-round`. |
| Review, `quality/high` | OpenCode, `openai/gpt-6.1-sol#xhigh` | The diff (up to 200,000 characters) and the PR title and body only | Metered, at maximum reasoning effort |
| Review, `quality/mid` | OpenCode, `openai/gpt-6.1-sol`, whatever the diff size | The diff (up to 100,000 characters) and the PR title and body only | Metered |
| Review, default tier, 400 diff lines or fewer | `claude -p`, `claude-haiku-5-5`, 4 turns, `Read` tool only | The diff (up to 60,000 characters) and the PR title and body only | Subscription, so no per-token cost |
| Review, default tier, 401 to 800 diff lines | OpenCode, `openai/gpt-6.1-sol` | Same | Metered: $2 per million input tokens and $10 per million output tokens |
| Review fallback | `claude -p`: Opus for `quality/high`; otherwise Haiku for 400 lines or fewer, Opus for more. Skipped while the Claude quota guard is blocked: the review then takes the manual-review path. | Same | Subscription |
| Any Claude role above, under a Claude quota block | OpenCode, `openai/gpt-6.1-sol`, same task and same worktree | Unchanged | Metered, against the separate OpenAI quota |
| Review, over the tier line cap (800 default, 1,600 `quality/mid`, 4,000 `quality/high`) | None. A hand-off comment, and the label moves to `status/ai-reviewed` as the owner's cue. | None | None |

The quality tier is checked before the size: the default tier is "the
cheapest sufficient model", `quality/mid` buys a full-strength reviewer at
any size, and `quality/high` buys the top model at maximum effort. The tier
also raises the line and input caps, because a truncated diff would
silently under-review a large high-tier PR. `SDG_REVIEW_ENGINE` and
`SDG_REVIEW_MODEL` still override the routing for every PR. The fallback
does not follow the tier fully: a `quality/mid` PR of 400 lines or fewer
falls back to Haiku.

The routing follows from where open-ended reasoning is needed:

- **Implementation is unbounded.** The engine has to choose a change, read the
  code, edit several files, and get the tests to pass. The strongest model is
  used here, and the run is capped by turns and wall-clock time.
- **Review is bounded by the diff.** For a small diff, a small model with no
  repository access is enough to find correctness, edge-case, security, and
  missing-test issues.
- **Large diffs go to a stronger metered model**, under a line cap and a
  character cap. The caps bound the input of one review, not its total cost.
  An illustrative estimate for one successful metered review: at about
  4 characters per token, 60,000 characters of diff plus a 3,000-character
  description is roughly 16,000 input tokens, or about $0.03. A typical
  output is a JSON findings list of a few thousand tokens, or a few cents.
  Twenty such reviews a day come to around $1. Higher tiers cost more: a
  `quality/high` review can send 200,000 characters (about 50,000 input
  tokens, about $0.10) and, at `#xhigh` effort, spends more output tokens on
  reasoning. This is an estimate, not a
  measured bill, and not a bound: the daily and per-tick counters count only
  successful reviews, a failed metered attempt is still billed, and nothing
  caps the engine's output tokens. A hard daily bound would require counting
  attempts rather than successes against the budget, and capping output
  tokens or spend on the metered engine. Fix-round re-reviews draw on the
  same 20-per-day budget. During a Claude quota failover, reviews that would
  have run on Haiku also go to metered Sol.
- **Fixing is unbounded again.** Addressing a finding means reading code
  beyond the diff, editing, and getting the tests to pass, so fix rounds use
  the implementation model with repository access, not the review models.
  They run on the subscription and are capped at 4 runs a day.
- **Speed tiers are never used** (`-fast`, `-ultrafast`). They cost more per
  token, not less (see incident 5.5). Batch review has no latency requirement.
- **A fallback must reset the model ID.** If the OpenCode run fails, the
  Claude fallback picks a Claude model. It never passes an OpenAI model ID to
  the Claude CLI.

The creation and conflict-repair Claude Code launches go through
`headroom wrap`, a context-compression proxy, on a dedicated port
(`HEADROOM_PORT=8789`). The fix-round job calls `claude -p` directly,
without the proxy. Where the proxy is used, the port must be set on every
launch. The proxy process is stopped after each run, because a leftover
proxy holds about 700 MB of memory.

### Claude quota guard

The owner's Claude Max 5x plan allows about 40 million tokens per rolling
5-hour window. The owner's manual income work draws on the same window. The
guard's purpose is that automation never uses up the window the owner needs.
It does not stop the automation: when Claude is blocked, every job that
would launch Claude runs the same task on `openai/gpt-6.1-sol` through
OpenCode, which draws on a separate OpenAI quota.

| Part | Role |
|---|---|
| `claude-quota.sh` | The gauge. Reads the active 5-hour block with `ccusage blocks --active --offline` over the Claude config directories on this host (the cron home and the owner's manual VPS sessions). Prints one line, `PCT TOKENS COSTUSD BURNRATE` (percentage of `SDG_CLAUDE_5H_TOKEN_LIMIT`, total tokens, block cost in USD, cost per hour). Exits 10 when the percentage is at or above `SDG_QUOTA_PCT` (90), and 0 otherwise. Any telemetry failure prints `-1 0 0 0` and exits 0. The token count includes cache reads, which the plan weighs less, so the gauge reads high and fails over early. |
| `lib-quota.sh` | The guard. Sourced by `sdg-autopr.sh`, `sdg-conflict-patrol.sh`, `sdg-fixround.sh`, and `sdg-autoreview.sh`. It never exits, never returns non-zero, and never blocks a run. If the library is missing, each script falls back to stubs that keep Claude. |

How the guard decides, just before each engine launch
(`quota_engine_default`):

1. **Reactive layer.** If `$H/.autopr-sdg/quota-blocked` exists and is
   younger than 5 hours, the engine is OpenCode. After a Claude run in
   creation, conflict repair, or a fix round, `quota_scan_output` checks the
   last lines of the transcript for a usage-limit or rate-limit error (for
   example "usage limit reached", `API Error: 429`). If it finds one, it
   writes the marker. A run whose output contains its own success line
   (`DONE https://`, `RESOLVED:`, `FIXED:`) is never flagged. The marker
   expires after 5 hours, which is when the block has rolled over.
2. **Proactive layer.** Otherwise, if the gauge exits 10, the engine is
   OpenCode.
3. Otherwise the engine is Claude. A broken or missing gauge reads as "not
   blocked", so the guard fails open and Claude is kept.

Alerts (standard output, delivered by the job's cron entry):

- One 🛑 "Claude quota failover ACTIVE" line per crossing (marker
  `quota-alerted`), and one ✅ "Claude quota recovered" line when the next
  engine launch finds Claude unblocked.
- A burn-rate alarm: one 🔥 line per hour at most (marker
  `quota-burn-alerted`) when the active block costs more than
  `SDG_BURN_ALERT_USD_HR` ($20) per hour and has already cost at least
  `SDG_BURN_ALERT_MIN_USD` ($1). The minimum cost keeps the first seconds of
  a block from showing a huge hourly rate. The alarm only reports; it
  never changes the engine. Creation, conflict repair, and fix rounds check
  it on every tick, before their locks, so a runaway is caught even while
  another job holds the repo lock. Review checks it only before a Claude
  launch.

Manual control: `date +%s > $H/.autopr-sdg/quota-blocked` forces the
failover, and deleting that file ends it. Configuration comes from
environment variables, or else from `$H/.autopr-sdg/quota.env` (`KEY=VALUE`
lines, parsed, never sourced).

Per job:

- **Creation, conflict repair, and fix rounds** run the same task in the
  same worktree on OpenCode. The proxy wraps Claude only. OpenCode runs have
  no turn cap, only the wall-clock timeout. In fix rounds, `git push` is
  denied to OpenCode by a permission rule
  (`OPENCODE_CONFIG_CONTENT`), as it is denied to Claude by
  `--disallowedTools`. Creation's channel message names the failover engine.
- **Review.** Even small Haiku reviews draw on the same 5-hour window, so a
  Claude-routed review runs on `openai/gpt-6.1-sol` while the guard is
  blocked. If an OpenCode review fails while the guard is blocked, the
  Claude fallback is skipped. The script logs "review deferred to next
  tick", but the review actually takes the manual-review path: a `failed`
  ledger entry, which no later tick retries (section 3). Review transcripts
  are not scanned, so a review that hits the limit does not set the reactive
  marker.

### Quality tiers

`quality/*` labels set the engine-and-effort contract for a PR: which models
run the work, how hard they think, and how many review rounds are expected.
They are independent of `priority/*`, which sets urgency only. The labels
and their contracts are defined in `docs/LABELS.md`; `blueprint/LABELS.md`
section 8 describes who sets them and what enforces them.

| Tier | Who sets it | Contract |
|---|---|---|
| `quality/low` | Creation, on every daily-stream PR (an instruction in the creation prompt, not verified by the script) | The cron path in this document: Opus implements, diff-scoped review routed by size (800-line cap), score gate at 8, automated fix rounds. |
| `quality/mid` | A person or the orchestrator, by upgrading | The cron reviewer uses standard Sol regardless of diff size, with a 1,600-line cap. An owner look before merge. |
| `quality/high` | A person or the orchestrator, for architectural or process work | The cron reviewer uses GPT-6.1-Sol at `#xhigh` effort, with a 4,000-line cap. The orchestrator implements with Opus at `ultrathink` effort, runs a multi-round score-gated fix loop, and works through the findings and trade-offs with the owner before the merge decision. |

The cron reviewer is the only job that reads `quality/*`: it picks the
review model and the size and input caps by tier (Engine routing, above).
Creation, fix rounds, and conflict repair ignore the tier, so a higher-tier
PR on an `auto-pr/*` branch still goes through the standard fix rounds. The
remaining mid and high obligations are carried out by the orchestrator on
top of the cron path, under the same rules as the cron loop: a round budget
it does not reset itself, and a human merge.

### Concurrency and isolation

| Lock | Held by | Protects |
|---|---|---|
| `$H/.autopr-sdg/lock` | Creation | Prevents two creation cycles from running at once. |
| `$H/.autopr-sdg/repo.lock` | Creation, conflict repair, and fix rounds | The shared clone. Creation runs `git checkout master` and `git reset --hard origin/master` in it. Conflict repair and fix rounds add and remove linked worktrees from it. A fix round holds the lock for its whole run: up to 25 minutes of engine time plus `npm ci` and an orchestrator test run of up to 10 minutes. |
| `$H/.autopr-sdg/autoreview/lock` | Review | Prevents two review ticks from running at once. Review never touches a checkout (it uses `gh` only), so it does not take the repo lock. |

All locks are non-blocking (`flock -n`). A busy lock makes the tick exit and
leaves the work to the next tick. It never queues behind the other job.

Worktree isolation:

- **Conflict repair** creates a dedicated linked worktree for each PR it
  processes and removes it afterwards. A fresh worktree has no `node_modules`,
  so the script runs `npm ci` before any tests.
- **Fix rounds** do the same in their own linked worktree
  (`wt-fixround`), one PR at a time.
- **Self-freeing.** Git allows a branch to be checked out in only one
  worktree. Before creating its worktree, conflict repair or a fix round
  lists every worktree with the PR branch checked out and force-removes
  each one. It posts "🧹 freed stale worktree <path> holding <branch>" for
  each removal, or a "cannot free worktree ... manual cleanup needed" alert
  if the removal fails. A worktree-creation failure also posts a channel
  line; before this change it was only logged. See incident 5.9.
- **Creation** works in the primary clone after a hard reset to
  `origin/master`. The repo lock keeps it from interfering with conflict
  repair and fix rounds.
- **Manually started jobs** (feature implementation, manual review and fix
  sessions, documentation) each get their own worktree on their own branch.
  They never share a checkout with each other or with the cron jobs. A
  manual worktree that has a PR branch checked out can be
  removed by self-freeing when that PR enters a fix round or conflict
  repair. `--force` also discards uncommitted changes. A manual session on
  such a branch should commit early, or work on a separate branch.

### State on disk

| Path under `$H/.autopr-sdg/` | Meaning |
|---|---|
| `run.log` | Creation log. Its `ok:` lines are the authoritative daily quota count. |
| `last_pr_ts` | Time of the last successful PR. Used for the cooldown. |
| `daydone-<date>` | The daily summary has been posted for this date. |
| `fail_streak`, `fail_day`, `circuit-<date>` | Circuit breaker state. |
| `{claude,opencode}-<date>-<idx>.txt`, `fixconf-<pr>-<ts>.txt` | Engine transcripts for each cycle (creation files are named after the engine that ran). Deleted after 14 days. |
| `autoreview/done-<pr>` | Review ledger: `<date> <verdict> <score> <head SHA>`. One review per code state: the reviewer skips the PR while the recorded SHA equals the PR head, and push detection re-queues it when they differ. Two-word verdicts are stored hyphenated (`request-changes`). Entries without a SHA (`<date> failed`, `<date> skipped-size` after an oversize hand-off, and legacy three-field entries) mean "manual from here": they are never re-queued by push detection. A legacy entry is upgraded on the PR's next review. |
| `autoreview/rounds-<pr>` | One score per line, one line per scored review. The per-PR lifetime round budget. Never deleted by automation. |
| `autoreview/findings-<pr>.json` | Findings, score, summary, round, threshold, and reviewed head SHA of the last below-gate review. Written on a fix outcome, deleted on a pass or cap. Read by the fix-round job. |
| `autoreview/count-<date>` | Number of successful reviews that day. |
| `autoreview/budget-alerted-<date>` | The "day budget spent" alert has been posted for this date. |
| `autoreview/fixround/count-<date>` | Fix-round engine runs that day, counted at dispatch. |
| `autoreview/fixround/pr-<n>/{date,attempts}` | Fix-round attempts per PR per day. |
| `autoreview/fixround/pr-<n>/alerted-atcap` | The attempt-cap alert has been posted for this PR today. Removed when the PR is next dispatched. |
| `autoreview/fixround/{claude,opencode}-<pr>-<ts>.txt`, `test-<pr>.txt`, `fixround.log` | Fix-round transcripts (named after the engine that ran), orchestrator test output, and log. Transcripts, test output, and counters are deleted after 14 days. |
| `conflict-patrol/pr-<n>/{date,attempts}` | Conflict-repair attempts per PR per day. |
| `conflict-patrol/alerted-nofindings-<pr>` | The reconciler has alerted once about this `status/fix-round` PR without a findings file. Removed when a findings file appears. |
| `quota.env` | Optional quota-guard configuration, `KEY=VALUE`. Environment variables take precedence. |
| `quota-blocked` | Reactive failover marker: epoch on the first line, the matching error line below it. Expires after 5 hours. Write it to force the failover; delete it to end the failover. |
| `quota-alerted`, `quota-burn-alerted`, `quota.lock` | One-alert-per-crossing and one-burn-alarm-per-hour markers, and the lock that serializes marker updates across jobs. |
| `review-off` | Review kill switch. Review is disabled while this file exists. |
| `fixround-off` | Fix-round kill switch. Fix rounds are disabled while this file exists. |

### Notification design

Hermes delivers whatever a `no_agent` script prints to standard output, and
delivers nothing when the output is empty. The pipeline builds on that:

- **One message per unit of work.** Units of work are: a PR created, a PR
  reviewed (including its score-gate outcome), a PR handed to the owner
  for being over its size cap, a PR re-queued by push detection, a fix
  round pushed or failed, a conflict-label transition, a label repaired by
  the reconciler, a stale worktree freed, a failed cycle, a toolchain
  repair, a quota failover or recovery, and the daily summary.
- **A stall is announced once.** Every guard that can leave a PR waiting
  for a human or for the next day posts one alert per unit of work,
  guarded by a marker file: the fix-round attempt cap (once per PR per
  day), the review day budget (once per day), and the reconciler's
  `status/fix-round` without a findings file (once per PR). The quota guard
  follows the same pattern: one 🛑 per crossing, one ✅ per recovery, and at
  most one 🔥 burn alarm per hour. Before these markers, a capped PR was
  skipped silently, and the reconciler repeated its alert on every patrol
  tick. Guards that still stall silently are listed in `blueprint/LABELS.md`
  section 7.
- **Standard output is the only delivery path.** A script never sends to a
  channel itself. Two paths to the same channel caused every message to be
  posted twice (incident 5.1).
- **Idle ticks print nothing.** Nothing printed means nothing delivered.
- **Silence is made unambiguous.** Because an idle tick and a dead job look
  the same, creation posts exactly one summary per day: "day complete" when
  the plan is done, or "day ended short" when the window closes before the
  plan is done. The summary includes the backlog and the next day's plan.
- **A failure message carries the cause.** It includes the last few lines of
  the engine transcript, not only a log path, so diagnosing it does not
  require a shell session on the host.

---

## 3. The PR state machine

State is held in `status/*` labels on the PR. `docs/LABELS.md` holds their
canonical descriptions; `blueprint/LABELS.md` is the label-workflow
reference, with every transition, its trigger, its guards, and the routine
that performs it. This section is the summary. The `status/*` labels are
owned by the automation. People read them and do not set them.
They describe where the automation stands with a PR, not whether the PR may
be merged.

### States

| State (label) | Set by | Entry condition | Exit transitions | Guards |
|---|---|---|---|---|
| `status/awaiting-ai-review` | Creation, fix rounds, push detection, conflict repair Phase 2, the reconciler (patrol Phase 3) | Creation opens the PR with this label. A fix round re-queues the PR after a verified push, or when its findings are stale. Push detection re-queues a reviewed PR whose head moved. Phase 2 re-queues a PR after a conflict repair. Every re-queue clears the review ledger `done-<pr>`. The reconciler gives this label to an `auto-pr/*` PR that has lost every `status/*` label and has no findings file; it does not touch the ledger. | The cron review posts a scorecard and applies the score gate (section 2): pass goes to `status/ai-reviewed`, fix goes to `status/fix-round`, cap goes to `status/ai-reviewed` with a "human review required" comment. A diff over the line cap of its quality tier is handed to the owner: a comment, `status/ai-reviewed`, and a `skipped-size` ledger entry without a SHA. An engine output without a parsable findings list (`failed`) leaves the label in place with a ledger entry and no SHA: manual review. If the ledger already records the current head SHA (a tick died after writing it), the label transition is re-applied from the ledger and the PR is not reviewed again. Phase 0 of conflict repair replaces this label with `status/conflict`. | Ledger `done-<pr>`, 20 per day (one alert per day when spent), 2 per tick, tier line cap and input cap, kill switch, Claude quota guard. Only `auto-pr/*` head branches are picked up. The reviewer skips PRs that also carry `status/conflict`, `status/conflict-resolved`, or `status/fix-round`: a conflicting PR is not reviewed until conflict repair has rewritten its diff. |
| `status/ai-reviewed` | Review | The review posted its scorecard, and the score passed the gate or the round budget was exhausted. Or the diff was over its tier's size cap and the PR was handed to the owner without a scorecard. | Human merges, which ends the lifecycle. Push detection (review Phase 0) sees a head SHA different from the one in the ledger and moves the PR to `status/awaiting-ai-review`, clearing the ledger. Phase 0 of conflict repair sees `CONFLICTING` and adds `status/conflict`. | Human merge gate. No automated exit to merged. Push detection skips PRs that also carry `status/fix-round`, `status/conflict`, `status/conflict-resolved`, or `status/awaiting-ai-review`, and PRs whose ledger entry has no SHA, which includes every handed-off PR. |
| `status/fix-round` | Review (score gate, fix outcome), the reconciler (restore) | The review scored the PR below 8 at a round below 10 and saved the findings to `findings-<pr>.json`. The reconciler restores the label on an `auto-pr/*` PR that lost every `status/*` label while its findings file still exists. | The fix-round job addresses the findings, passes verification, pushes, and moves the PR to `status/awaiting-ai-review`, clearing the ledger. If the findings were recorded for a head SHA that is no longer the PR head, the job re-queues the PR the same way without an engine run. When verification fails, the label stays and the job retries on a later tick. Phase 0 of conflict repair adds `status/conflict` next to this label. | 4 engine runs per day, 2 attempts per PR per day (one alert per PR per day at the cap), 1 per tick, repo lock, kill switch, worktree self-freeing, Claude quota guard. Skips PRs that also carry `status/conflict`, `status/conflict-resolved`, or `status/awaiting-ai-review`, PRs whose mergeability is `UNKNOWN` or `CONFLICTING`, and PRs with no findings file. Verification before the push: branch and history intact, no merge or rebase in progress, clean tree, no conflict markers, no attribution in any new commit, the orchestrator's own `npm test` passes, and the PR is still open and still labeled `status/fix-round`. |
| `status/conflict` | Conflict repair | Phase 0: the PR is open, assigned to the owner, `mergeable` is `CONFLICTING`, and it has neither `status/conflict` nor `status/conflict-resolved`. Phase 0 removes `status/awaiting-ai-review` in the same edit, but leaves `status/ai-reviewed` or `status/fix-round` in place. | Becomes `status/conflict-resolved` once a repair passes verification, or once the PR is found to be no longer `CONFLICTING`. Stays when verification fails, until the next tick. Stays when the attempt cap is reached, until the next day or a human acts (logged only, no alert). | 2 attempts per PR per day (clean merges count as attempts), `UNKNOWN` deferred, repo lock, worktree self-freeing, Claude quota guard on the engine run, verification: push landed, no attribution in the last commit, no conflict markers, GitHub reports neither `CONFLICTING` nor `UNKNOWN`. |
| `status/conflict-resolved` | Conflict repair | Phase 1 succeeded: the branch was merged with its base and passed the mechanical checks listed above, or the PR stopped conflicting on its own. The label does not mean the tests passed. | Phase 2 replaces it with `status/awaiting-ai-review` and deletes `autoreview/done-<pr>`, so the merged result gets reviewed again. Phase 2 does not remove a lifecycle label left over from before the conflict. A leftover `status/ai-reviewed` is removed by the next review transition. A leftover `status/fix-round` deadlocks the PR (label hygiene, below). | Phase 0 skips PRs with this label, so they cannot be relabeled in a loop. The round budget is not reset. |
| Merged or closed | Human | Explicit human action | None (end of lifecycle) | Merge commits only (`gh pr merge --merge`). Merges happen only on explicit request. |

**Label hygiene.** The review, push-detection, and fix-round transitions
remove every lifecycle label the target state excludes: a pass, cap, or
oversize hand-off removes `status/awaiting-ai-review` and
`status/fix-round`, a fix outcome
removes `status/awaiting-ai-review` and `status/ai-reviewed`, push detection
removes `status/ai-reviewed`, and a fix round removes `status/fix-round`.
After one of these transitions a PR carries exactly one `status/*` label,
unless conflict repair has added `status/conflict` or
`status/conflict-resolved` alongside: none of these transitions removes
the conflict labels.
Each transition is idempotent, so re-applying it after a lost tick is safe.
Conflict repair follows the rule only in part. Phase 0 removes
`status/awaiting-ai-review` when it adds `status/conflict`, so a PR that was
queued for review carries exactly one `status/*` label. It still adds
`status/conflict` next to `status/ai-reviewed` or `status/fix-round`, and
Phase 2 adds `status/awaiting-ai-review` without removing that leftover. A
PR can therefore carry two `status/*` labels during and just after a
conflict repair, for example `status/ai-reviewed` and `status/conflict`.
The reviewer skips any PR that carries `status/conflict`,
`status/conflict-resolved`, or `status/fix-round`, so it never reviews
pre-merge code that conflict repair is about to rewrite. Read the current
state with this precedence, which matches the exclusion filters the jobs
apply:

```
conflict > conflict-resolved > awaiting-ai-review > fix-round > ai-reviewed
```

After Phase 2, a leftover `status/ai-reviewed` is harmless: the reviewer
picks the PR up and its transition removes the leftover. A leftover
`status/fix-round` is a **deadlock (known gap)**. A PR that starts
conflicting while it waits in a fix round ends up with `status/fix-round`
and `status/awaiting-ai-review`. The fix-round job skips it because of
`status/awaiting-ai-review`, and the reviewer skips it because of
`status/fix-round`. The reconciler sees a label and a findings file, so it
neither repairs nor alerts. Until the scripts handle this case, the owner
removes `status/fix-round` by hand, and the reviewer then picks up the PR.

**Merge permission.** Lifecycle labels reflect automation state, not merge
permission. The human owner may merge any PR at any time, whatever its
labels say. `status/ai-reviewed` as the sole `status/*` label means only
that the automation has finished with the PR in its current code state.
Usually it has posted a scorecard. After a cap, the scorecard says so, and
the PR needs a human review before any merge. After an oversize hand-off
there is no scorecard at all, only the hand-off comment.

**Oversize hand-off.** A PR whose diff is over the line cap of its quality
tier (800 by default, 1,600 for `quality/mid`, 4,000 for `quality/high`)
is not reviewed. The reviewer posts a comment ("Automated review skipped:
N diff lines exceeds the size cap for its quality tier ... human review
required"), moves the label to `status/ai-reviewed` as the owner's cue,
and writes `<date> skipped-size` to the ledger, without a SHA. No engine
runs and no round or daily budget is spent. An earlier version left such a
PR at `status/awaiting-ai-review`, where it looked queued forever and
stalled the loop. Because the ledger entry has no SHA, push detection does not
re-queue the PR after later pushes; the owner reviews it by hand. If the
PR later conflicts, conflict repair Phase 2 deletes the entry and the
reviewer hands it off again, unless the merged diff now fits the cap.

**Manual review.** When no engine, fallback included, returns a parsable
findings list, the cron reviewer writes `<date> failed` to the ledger. This
also happens when an OpenCode review fails while the Claude quota guard is
blocked: the Claude fallback is skipped, and the review is not retried on
the next tick. The reviewer then writes `<date> failed`,
without a SHA, posts one "auto-review failed ... review manually" line to
the channel, and leaves the label at `status/awaiting-ai-review`. There is
no relabel and no scorecard. The owner reviews the PR by hand and merges
it, or not, without changing the label. The ledger entry blocks only the
cron reviewer and push detection from picking the PR up again. Nothing
else reads it: conflict repair, merging, and manual sessions ignore it. If
the PR later conflicts, conflict repair Phase 2 deletes the entry as usual,
and the cron reviewer tries again on the merged result.

**Further changes on a reviewed PR.** When the owner wants more changes on a
`status/ai-reviewed` PR, the owner or a manually started session pushes
commits to the PR branch. Push detection re-queues the PR on the next review
tick, and the score gate applies again, using rounds from the same lifetime
budget. A manual session does not set `status/*` labels by hand. In
particular, a hand-set `status/fix-round` without a findings file is
ignored by the fix-round job and excluded from push detection, so nothing
automated clears it. The reconciler treats it as a manual or session fix
round: it posts one alert per PR and never changes the label.

**Label reconciler.** Patrol Phase 3 makes sure no open `auto-pr/*` PR sits
without a `status/*` label, whatever removed it (a manual edit, a lost
transition). If `findings-<pr>.json` exists, the PR was mid fix loop and
gets `status/fix-round` back. Otherwise it gets `status/awaiting-ai-review`
and re-enters the pipeline; the review ledger is left as it is, so a PR
whose current head was already reviewed has its recorded outcome re-applied
instead of a second review. The reconciler only fills in a missing label.
It does not resolve stacked or wrong labels.

### Label lifecycle

This diagram is literally identical to the one in `blueprint/LABELS.md`
section 5.

```mermaid
stateDiagram-v2
    state "status/awaiting-ai-review" as awaiting
    state "status/ai-reviewed" as reviewed
    state "status/fix-round" as fixround
    state "status/conflict" as conflict
    state "status/conflict-resolved" as resolved
    state "Manual review - label unchanged, ledger without SHA" as manual
    state "No status label - manual edit or lost label" as unlabeled
    state "Merged" as merged
    state gate <<choice>>

    [*] --> awaiting : creation opens PR
    awaiting --> gate : cron review posts scorecard
    gate --> reviewed : pass - score 8 or more
    gate --> fixround : fix - score below 8, round below 10, findings saved
    gate --> reviewed : cap - score below 8 at round 10 or later, human review required
    awaiting --> reviewed : over tier size cap - hand-off comment, no scorecard, ledger skipped-size
    awaiting --> manual : no parsable findings list, fallback included
    manual --> merged : human owner reviews by hand and merges, label unchanged
    unlabeled --> awaiting : phase 3 reconciler - no findings file, re-enters pipeline
    unlabeled --> fixround : phase 3 reconciler - findings file exists, label restored
    fixround --> awaiting : fix-round job pushes verified fixes, ledger cleared
    fixround --> awaiting : findings stale - head moved since review, ledger cleared
    fixround --> fixround : verification failed, retry, max 2 attempts per PR per day
    reviewed --> awaiting : push detection - head moved since review, ledger cleared
    reviewed --> merged : human merges
    awaiting --> conflict : phase 0 detects CONFLICTING
    reviewed --> conflict : phase 0 detects CONFLICTING
    fixround --> conflict : phase 0 detects CONFLICTING
    conflict --> conflict : verification failed, retry next tick, max 2 per day
    conflict --> resolved : merge pushed, mechanical checks pass, tests not checked
    conflict --> resolved : PR no longer CONFLICTING
    resolved --> awaiting : phase 2 re-queues and clears review ledger
    merged --> [*]
```

`Merged` is reachable from every state by explicit human action; the
diagram shows only the usual paths. A transition into `status/conflict`
replaces `status/awaiting-ai-review`, but is added next to
`status/ai-reviewed` or `status/fix-round`, as described under label
hygiene. Not drawn: a `status/fix-round` without a findings file makes the
reconciler post one alert per PR and change nothing.

### Factory pipeline

```mermaid
flowchart TD
    WD["claude-watchdog.sh at :25 and :55 repairs claude, headroom, opencode"] -.-> A
    A["sdg-autopr.sh tick at :00 and :30"] --> B{"Slot due, quota left, cooldown passed, breaker closed, backlog at most 30?"}
    B -->|no| B0["Exit silently, or post the daily summary once"]
    B -->|yes| C["Claude Code Opus plans, codes, runs tests, pushes, opens PR"]
    C --> D{"PR found on GitHub?"}
    D -->|no| D0["Post AUTOPR FAIL with transcript tail, extend failure streak"]
    D -->|yes| E["Audit and scrub AI attribution, post PR notification"]
    E --> F["status/awaiting-ai-review"]

    F --> R["sdg-autoreview.sh tick at :20 and :50"]
    R --> R1{"Kill switch off, budget left, no conflict or fix-round label, no ledger entry for the current head SHA?"}
    R1 -->|no| R0["Wait for a later tick or day, one alert per day when the budget is spent"]
    R1 -->|yes| RS{"Diff over the tier line cap? high 4000, mid 1600, otherwise 800"}
    RS -->|yes| RH["Oversize hand-off: comment, no scorecard, ledger skipped-size without SHA"]
    RH --> G
    RS -->|no| R2{"Quality tier, then size"}
    R2 -->|quality/high| R7["GPT Sol xhigh via OpenCode, diff only, Opus fallback"]
    R2 -->|quality/mid, any size| R4["GPT Sol via OpenCode, diff only"]
    R2 -->|default, at most 400 lines| R3["Haiku via claude -p, diff only, Sol under a Claude quota block"]
    R2 -->|default, over 400 lines| R4
    R5["Manual review: label stays status/awaiting-ai-review, ledger entry without SHA"]
    R3 --> R6["Keep findings in changed files, score them, post one scorecard"]
    R4 --> R6
    R7 --> R6
    R3 -->|no parsable findings list, fallback included| R5
    R4 -->|no parsable findings list, fallback included| R5
    R7 -->|no parsable findings list, fallback included| R5
    R5 -->|human owner reviews by hand and merges at any time| M
    R6 --> GT{"Score gate"}
    GT -->|score 8 or more| G["status/ai-reviewed"]
    GT -->|below 8 at round 10 or later| GC["Cap comment: human review required"]
    GC --> G
    GT -->|below 8, round below 10| FR["status/fix-round, findings saved to findings-pr.json"]

    FR --> X["sdg-fixround.sh tick at :10 and :40"]
    X --> XK{"Kill switch off and repo lock free?"}
    XK -->|no| X0
    XK -->|yes| X1{"Findings recorded for the current head SHA?"}
    X1 -->|no, branch moved| XQ["Re-queue without an engine run, review ledger cleared"]
    X1 -->|yes| X2{"4 per day and 2 per PR per day left, first PR this tick, mergeable, not in the conflict loop?"}
    X2 -->|no| X0["Wait for a later tick or day, one alert per PR per day at the attempt cap"]
    X2 -->|yes| X3["Free the branch from any foreign worktree, then Claude Code Opus, or Sol under a Claude quota block, fixes every finding in a worktree, one commit per finding, cannot push"]
    X3 --> X4{"Orchestrator checks pass? History intact, clean tree, no attribution, own npm test passes, PR still open in fix-round"}
    X4 -->|no| X5["Label stays, retry on a later tick"]
    X4 -->|yes| X6["Push, re-queue, review ledger cleared"]
    XQ --> F
    X6 --> F

    G --> H{"Human decision"}
    H -->|merge| M["Merged"]
    H -->|push more commits| PD["Review phase 0, push detection: head moved since review, ledger cleared"]
    PD --> F

    G -.->|base branch moves| P["sdg-conflict-patrol.sh tick at :05 and :35"]
    F -.->|base branch moves| P
    FR -.->|base branch moves| P
    P --> P0["Phase 0: CONFLICTING PR labeled status/conflict, status/awaiting-ai-review removed"]
    P0 --> P1{"Branch freed from any foreign worktree. git merge of base is clean?"}
    P1 -->|yes| P2["Push merge commit, no LLM, no tests run"]
    P1 -->|no| P3["Claude Code Opus, or Sol under a Claude quota block, resolves in worktree, is told to run npm test, pushes"]
    P2 --> V{"Orchestrator checks pass? Push landed, no markers or attribution, mergeable. Test results not checked."}
    P3 --> V
    V -->|no| V0["Retry next tick, max 2 attempts per day"]
    V -->|yes| V1["status/conflict-resolved"]
    V1 --> V2["Phase 2: status/awaiting-ai-review, review ledger cleared, round budget kept"]
    V2 --> F

    U["Open auto-pr PR with no status label: manual edit or lost label"] -.-> RC{"Phase 3 reconciler, every patrol tick: findings file exists?"}
    RC -->|yes| FR
    RC -->|no| F
    FR -.->|fix-round without findings file| RA["One alert line per PR, label untouched"]
```

---

## 4. Token frugality

**Principle: automation multiplies tokens. Every automated path needs a
budget and an off switch.** A manual prompt costs tokens once. A cron entry
that runs every 30 minutes can spend them 48 times a day, indefinitely, and
a bug in a loop spends them faster. Each stage of the pipeline therefore
bounds the cost of a single run, the number of runs, and the total, and has
a way to be stopped.

| Control | Stage | Mechanism | Effect |
|---|---|---|---|
| Diff-scoped input | Review | The engine receives only the PR title, up to 3,000 characters of description, and the diff. It runs in an empty temporary directory with the `Read` tool only. | Review cost depends on the diff size, not the repository size. |
| Input cap | Review | Diff truncated to 60,000 characters (100,000 for `quality/mid`, 200,000 for `quality/high`). Null bytes stripped. | Bounds the input of a single review. The tier buys a larger bound. |
| Line cap | Review | Diffs over 800 lines (1,600 for `quality/mid`, 4,000 for `quality/high`) are not reviewed: hand-off comment, `status/ai-reviewed`. | The most expensive reviews go to the human, with an explicit cue. |
| Model routing | Review | By tier first: `quality/high` Sol at `#xhigh`, `quality/mid` standard Sol. Default tier: Haiku (subscription) for 400 lines or fewer, standard Sol (metered) above. Never a speed tier. | Default-tier reviews mostly have no per-token cost. Higher tiers pay for strength by explicit choice. |
| One review per code state | Review | `done-<pr>` records the reviewed head SHA. It is written after a review, an oversize hand-off, or an engine failure. It is cleared by a fix-round push, a stale-findings re-queue, push detection, or a conflict repair. | The cron reviewer reviews each code state of a PR once, not once per tick. A size skip or engine failure writes no SHA, so that PR is never re-reviewed automatically until a conflict repair clears the entry. |
| Daily and tick budgets | Review | 20 successful reviews per day (`SDG_REVIEW_MAX_DAY`), 2 per tick. When the day budget is spent, one channel alert per day. | Limits successful reviews per day and per tick. Failed attempts are not counted (see known gaps). Fix-round re-reviews draw on the same budget. Raised from 10 on 2026-10-26: the fix loop multiplies reviews, and 10 per day ran out by early afternoon, leaving `status/awaiting-ai-review` PRs waiting for hours with no message. |
| Claude quota guard | Creation, conflict repair, fix rounds, Claude-routed reviews | Gauge at or above 90% of the 5-hour window, or a usage-limit error in a recent Claude transcript, switches the engine to `openai/gpt-6.1-sol` via OpenCode (section 2). A burn rate above $20 per hour raises one alarm per hour. | Automation cannot use up the Claude window the owner needs for manual work. |
| Per-PR lifetime round budget | Review, fix rounds | Every scored review appends to `rounds-<pr>`. Below the gate at round 10 or later, the PR goes to the human instead of another fix round. Automation never resets the file. | At most 9 review-triggered fix rounds per PR, ever. Fix-run attempts that fail verification consume no round: they are bounded per day (2 per PR), not per lifetime; see known gaps. |
| Kill switch | Review | `touch $H/.autopr-sdg/review-off` disables review. `rm` re-enables it. | Immediate stop without editing cron. |
| Fix-round budgets | Fix rounds | 4 engine runs per day, counted at dispatch so failed runs count. 2 attempts per PR per day. 1 engine run per tick. | At most 4 Opus fix runs a day, and a single PR cannot take more than 2 of them. |
| Repo lock hold | Fix rounds | A fix round holds `repo.lock` for up to about 25 minutes of engine time plus `npm ci` and a test run of up to 10 minutes. | Creation and conflict repair skip their ticks while it runs, which also bounds how much of the day fix rounds can occupy. |
| Fix-round kill switch | Fix rounds | `touch $H/.autopr-sdg/fixround-off` disables fix rounds. `rm` re-enables them. | PRs stay in `status/fix-round` until it is removed. Nothing else is affected. |
| Test gate | Fix rounds | The orchestrator runs `npm test` itself and pushes only if it passes. The engine's `TEST_SUMMARY` line is required but not trusted. | A fix that breaks the suite is never pushed, so it never spends a review on broken code. |
| Daily plan | Creation | 3 to 10 PRs per day, seeded by the date. Slots are drawn between 08:00 and 21:00. | Fixed upper bound on implementation runs. |
| Cooldown and window | Creation | At least 40 minutes between PRs. Catch-up stops at 22:30. | No bursts after downtime. |
| Backlog gate | Creation | No new PR while more than 30 `auto-pr/*` PRs are open. | Creation cannot outrun the human. |
| Circuit breaker | Creation | 3 consecutive failed cycles stop creation for the rest of the day. `FORCE_SLOT=1` overrides it. | A broken environment does not spend a model run every 30 minutes. |
| Turn and time caps | Creation, conflict repair, fix rounds | 60 turns and 30 minutes for creation. 40 turns and 25 minutes for conflict repair and fix rounds. | Bounds a single run. |
| LLM only when needed | Conflict repair | A clean `git merge` is pushed without an engine. | Most conflict repairs spend no tokens. |
| Attempt cap | Conflict repair | 2 attempts per PR per day. | An unresolvable conflict cannot loop. |
| Context compression | Creation, conflict repair | `headroom wrap` proxy. A global shell-output reduction hook is also active. | Fewer tokens per turn on long runs. |

**Failover is an engine change, not a failure.** A quota failover does not
skip a run, count as a failed cycle, or relax a check. The OpenCode run gets
the same task, the same worktree, the same wall-clock timeout, and the same
budgets. The orchestrator verifies a GPT run exactly as it verifies a
Claude run. Creation checks that the PR exists and audits it for
attribution. Conflict repair checks the push, markers, attribution, and
mergeability. A fix round runs its full verification, including its own
`npm test`, and denies the engine `git push`. Only the engine and its
spending pool change. The price is metered OpenAI spend during the
failover, including reviews that would otherwise run on Haiku.

Known gaps:

- The daily and per-tick review counters count only successful reviews. An
  engine failure is recorded in the ledger, so it never repeats, but one tick
  can attempt more than two PRs if earlier attempts in that tick failed, and
  a failed metered attempt is billed without consuming the budget.
- The metered review engine has no output-token or spend cap. Review cost
  estimates (section 2) are illustrative, not bounds.
- Creation and conflict repair have no marker-file kill switch. They are
  stopped by disabling their cron entries.
- Fix-round attempts are bounded per day, not per lifetime. A fix round that
  never passes verification is retried twice a day, every day, until a human
  acts. The daily cap of 4 bounds the total, and each failure posts a
  message, so the loop is visible but not self-terminating.
- The score gate adds review spend: a PR that enters the fix loop gets one
  extra review per fix round, and stale-findings, push-detection, and
  conflict re-queues add more. Fix-round re-reviews can crowd out first
  reviews of new PRs on a busy day. This happened on 2026-10-26 at the old
  budget of 10. The budget is now 20, and a spent budget is announced once
  per day instead of silently stalling the queue.
- Tier routing is a price lever anyone with label access can pull: putting
  `quality/high` on a PR sends its review to Sol at `#xhigh` with a
  200,000-character input. The daily review budget still bounds the count,
  not the cost.
- The quota gauge sees only this host. `ccusage` reads the Claude sessions
  on the VPS (the cron home and the owner's manual VPS sessions), not the
  owner's laptop, but the plan limit is account-wide. Laptop usage reaches
  the guard only through the reactive layer: one automated Claude run has
  to hit the limit first, and that run is lost as a failed cycle, a failed
  conflict attempt, or a failed fix-round attempt.
- The reactive layer cannot tell a 5-hour usage limit from a short-lived
  rate limit. A transient 429 (requests per minute) in a Claude transcript
  also switches automation to GPT for the full 5 hours, unless someone
  deletes `quota-blocked`.
- Review transcripts are not scanned for limit errors, so a Haiku review
  that hits the limit does not set the reactive marker. It fails into
  manual review instead.
- Under a quota block, a failed OpenCode review is not deferred, although
  the script's log line says it is. It is written to the ledger as `failed`
  and goes to manual review (section 3).
- OpenCode runs have no turn cap, only the wall-clock timeout (30 minutes
  for creation, 25 for conflict repair and fix rounds).
- The 90% threshold is computed against `SDG_CLAUDE_5H_TOKEN_LIMIT`
  (40,000,000), a calibration by the owner on 2026-10-26, not a figure
  published by the plan. If the real limit differs, the ceiling moves with
  it.

---

## 5. Learnings (incident log)

Each incident is recorded with what happened, its root cause, and the
permanent fix. The fixes are encoded either in the scripts or in the
invariants in section 6.

### 5.1 Duplicate notifications

- **What happened.** Every created PR was announced twice in the review
  channel: one formatted message and one "Cronjob Response" echo.
- **Root cause.** The creation script sent its message with `hermes send`
  and also printed it to standard output. The cron entry delivers standard
  output to the same channel. There were two delivery paths into one channel.
- **Permanent fix.** Messages go to standard output only. The scripts carry a
  comment that forbids `hermes send`. The invariant is one delivery path per
  job.

### 5.2 Headroom proxy dependencies wiped while the health check stayed green

- **What happened.** Every `headroom wrap` launch failed immediately with
  "Proxy dependencies not installed" / `No module named 'fastapi'`. The
  watchdog still reported the toolchain as healthy.
- **Root cause.** A Hermes update re-provisioned its tools Python directory.
  The proxy extras were installed only in that directory, so they were
  deleted. The `headroom` CLI itself imports from the persistent `$H/.local`
  prefix, so the watchdog's `headroom --version` check kept passing. The
  check did not exercise the code path the pipeline actually uses.
- **Permanent fix.** The watchdog checks `import fastapi` with the pipeline's
  `PYTHONPATH`. When the import fails, it reinstalls `headroom-ai[proxy]`
  into the persistent prefix and rewrites the launcher. Manual verification
  is a real `HEADROOM_PORT=8789 headroom wrap claude -p ...` run, not
  `--version`.

### 5.3 pip install replaced the custom headroom launcher

- **What happened.** After a reinstall, the pipeline's `headroom` failed with
  `ModuleNotFoundError: No module named 'headroom'`.
- **Root cause.** `pip install --prefix $H/.local` writes its own console
  script to `$H/.local/bin/headroom`. That script is a bare Python shim
  without the `PYTHONPATH` the custom launcher sets, and it overwrote the
  launcher. An interactive shell could still find a different, working
  `headroom` elsewhere on its `PATH`, which hid the problem.
- **Permanent fix.** The watchdog rewrites the launcher after every pip
  install, in every reinstall branch. Verification runs
  `$H/.local/bin/headroom` by absolute path in a shell with a minimal `PATH`.

### 5.4 Control-character separator parsed by sed but not by grep

- **What happened.** The review scorecard comment on the PR was correct, but
  the channel notification for the same review had empty score, count, and
  verdict fields.
- **Root cause.** Metadata was passed in-band using a `\x01` separator. GNU
  `sed` interprets `\x01` and correctly stripped the metadata from the
  comment. GNU `grep` with a basic regular expression treats it as literal
  text, so the metadata extraction matched nothing.
- **Permanent fix.** A plain-text marker line (`===META=== score crit warn
  verdict`) is matched with `grep '^===META==='`. The pipeline scripts have
  no automated test suite (section 1), so the rule is procedural: after any
  change to the parse chain, a hand-run fixture must exercise the whole chain
  (scorecard, then metadata, then notification string), not just the step
  that produces the output.

### 5.5 Speed-tier pricing inversion

- **What happened.** An early routing design sent small diffs to a `-fast`
  variant of the review model, on the assumption that faster meant cheaper.
- **Root cause.** The tier names describe latency, not cost.
  `gpt-6.1-sol-fast` costs twice the standard price and `-ultrafast` six
  times. Batch review has no latency requirement, so the premium bought
  nothing.
- **Permanent fix.** Review routes only to standard `openai/gpt-6.1-sol` or
  to subscription-covered Claude models. The script header records the rule.
  Before routing to any model, check its price per token, not its name.

### 5.6 `python3 -` argument off-by-one

- **What happened.** A posted scorecard showed the path of `findings.json`
  where the PR number should have been (PR #46).
- **Root cause.** When a script is fed to `python3 -` from a here-document,
  `sys.argv[0]` is `-`. The first real argument is `argv[1]`. The scorecard
  builder was off by one.
- **Permanent fix.** The indexing was corrected. After any change to argument
  indexing, a fixture run of the builder is required.

### 5.7 Abort after side effects but before the ledger write

- **What happened.** The review script aborted after it had posted the
  scorecard comment and changed the label, but before it wrote
  `done-<pr>`. The PR was left without a ledger entry, so the one-review
  guarantee no longer held for it.
- **Root cause.** `set -u` combined with a variable-name case mismatch
  (`$engine` vs `$ENGINE`) raised an unbound-variable error midway through
  the sequence: comment, then label, then ledger.
- **Permanent fix.** The variable was corrected. Operating rule: after any
  mid-run abort, reconcile the ledgers with the labels. Every PR labeled
  `status/ai-reviewed` must have `autoreview/done-<pr>`, and any missing
  entries are written by hand. A structural improvement for new projects is
  to write an in-progress ledger entry before the first external side effect.
- **Current ordering.** The review now runs its side effects in the order
  scorecard, round entry, findings file, ledger, label. A tick that dies
  after the ledger write is healed by the next tick: it finds a ledger entry
  for the current head SHA and re-applies the lost label transition from the
  ledger instead of reviewing again. An abort before the ledger write still
  needs the reconciliation rule above, and it can also leave an extra line
  in `rounds-<pr>`, which consumes one round of the PR's budget.

### 5.8 GitHub label-index lag

- **What happened.** A PR labeled `status/conflict` in Phase 0 did not
  appear in Phase 1's `--label status/conflict` query in the same tick. The
  same lag applies between Phase 1 and Phase 2.
- **Root cause.** Label-filtered PR listing is served from an index that
  lags label writes. The same applies to `mergeable`, which reads `UNKNOWN`
  for a while after a push.
- **Permanent fix.** Every phase is idempotent and converges over successive
  ticks. Not finding a PR yet is never treated as a failure, and `UNKNOWN` is
  deferred. In practice a deferred transition typically resolves within one
  or two ticks (observed, not guaranteed; GitHub does not bound the lag).
  After a push, verification waits about 10 seconds before reading
  `mergeable`.
- **Detecting persistent deferral.** A transition that is stuck rather than
  lagging shows up as a PR whose `mergeable` stays `UNKNOWN`, or a labeled PR
  that the next tick's label query does not return, across multiple
  consecutive ticks. The intended detection mechanism reuses the creation
  job's failure-streak pattern (`fail_streak`): count consecutive ticks
  without progress per PR, and after 3 such ticks notify the owner once.
  Conflict repair does not implement this counter yet. Until it does, a stuck
  PR is visible only in the patrol log.

### 5.9 A leftover worktree stalled a fix round for 16 hours

- **What happened.** PR #92 sat in `status/fix-round` for about 16 hours
  with no fix pushed and no channel message after its two failed attempts.
- **Root cause.** A leftover worktree from an orchestrator session
  (`wt-blueprint`) still had the PR branch `auto-pr/9-...` checked out.
  Git refuses to check out a branch in a second worktree, so
  `git worktree add` in the fix-round job failed. Both attempts of the day
  died at that step, and the failure went only to `fixround.log`. The
  per-PR attempt cap (2 per day) then skipped the PR on every later tick,
  also only in the log. Each guard behaved as designed, and together they
  stalled the PR with no notification.
- **Permanent fix.** Fix rounds and conflict repair now free the branch
  before they create their worktree: they force-remove every worktree that
  has the PR branch checked out and post "🧹 freed stale worktree" for each.
  If a removal fails, they post a "manual cleanup needed" alert. A
  worktree-creation failure now posts a channel line. The fix-round
  attempt cap posts one alert per PR per day instead of skipping silently.
  General rule: a guard that can stall a PR must announce the stall once
  (section 2, Notification design). Trade-off: self-freeing also removes a
  manual session's worktree on that branch, including uncommitted changes
  (section 2, Concurrency and isolation).

### Other recorded pitfalls

| Pitfall | Rule |
|---|---|
| The daily quota was counted from GitHub and included PRs from other pipelines (the log showed `14/10`). | Count a job's output from its own success log lines. Use GitHub only as a fallback. |
| An "end of window" guard placed at the last slot silently turned every catch-up cycle into a no-op. | Close the window well after the last slot (22:30), and replay the historical log against any new guard before shipping it. |
| A review day budget of 10 ran out by early afternoon once the fix loop multiplied reviews, and `status/awaiting-ai-review` PRs waited for hours with no message (2026-10-26). | Size a budget for the loops that feed it, not only for first runs. Announce a spent budget once. The default is now 20 per day. |
| Two jobs drove the same clone under two different locks. | Shared mutable checkouts sit behind one shared lock (`repo.lock`). |
| `pkill -f 'headroom.cli proxy'` matched and killed its own shell. | Use a character class in the pattern: `prox[y]`. |
| `headroom wrap` without `HEADROOM_PORT` fell back to a stale proxy that could not be killed, and the run aborted. | Set the port in the same command on every launch. |
| Null bytes in diffs corrupted command substitutions. | Run `tr -d '\000'` before embedding a diff in a prompt. |
| `npm test` failed in a fresh worktree with errors that looked like regressions. | Run `npm ci` first. A new worktree has no `node_modules`. |
| A placeholder email in commit identity broke GitHub account linkage. | Check author and committer identities before every push. |
| Pushes touching `.github/workflows/**` were rejected. | The `gh` token needs the `workflow` scope. Grant it once with `gh auth refresh -s workflow`. |

---

## 6. Adapting this blueprint to a new project

### Parameters

| Parameter | Current value | Where it is set today |
|---|---|---|
| Hermes home | `<hermes-home>` (concrete path in the private runbook) | `H=` in all five scripts, in `claude-quota.sh`, and in the headroom launcher. `lib-quota.sh` takes `$H` from the script that sources it. |
| State root (mandatory, one per project) | `$H/.autopr-sdg`, with `autoreview/`, `autoreview/fixround/`, and `conflict-patrol/` below it | `STATE=` in `sdg-autopr.sh`, `sdg-plan.sh`, `sdg-autoreview.sh`, `sdg-fixround.sh`, and `sdg-conflict-patrol.sh`, plus the lock and kill-switch paths derived from `$H/.autopr-sdg` |
| Repository | `iamgerwin/sure-daily-github` | `R=` in all four `sdg-*` pipeline scripts |
| Local clone and job worktrees | `$H/Developer/_personal/sure-daily-github`, `.../wt-conflict`, `.../wt-fixround` | `REPO=`, `WT=` in conflict repair and fix rounds |
| Assignee | `iamgerwin` | Creation prompt (`--assignee`), Phase 0 filter, notification text |
| Script commit identity | Owner's name and email | Conflict repair Phase 1 clean merges and the fix-round leftover commit, both `git -c user.name=... -c user.email=...` |
| Base branch | `master` for creation. Conflict repair reads each PR's `baseRefName`. | Creation reset, prompt, and `--base` |
| Branch prefix | `auto-pr/` | Creation, review filter, backlog gate, `create-pr` skill |
| Time zone and window | Asia/Manila. Slots 08:00 to 21:00, catch-up until 22:30. | `TZ=`, plan generator, `SDG_AUTOPR_WINDOW_CLOSE_MIN` |
| Creation volume | 3 to 10 per day, 40-minute cooldown | Plan generator, `2400` literal |
| Backlog gate and breaker | 30 open PRs, 3 failures | `SDG_AUTOPR_MAX_OPEN`, `SDG_AUTOPR_MAX_FAILS` |
| Implementation model | `claude-opus-5-5` | `SDG_AUTOPR_MODEL`. The conflict-repair and fix-round models are literals. |
| Review engines and models | `quality/high`: Sol `#xhigh`, Opus fallback. `quality/mid`: Sol. Default: Haiku up to 400 lines, Sol above. | `SDG_REVIEW_ENGINE`, `SDG_REVIEW_MODEL` (override the tier routing for every PR). The tier models and the 400-line threshold are literals. |
| Review budgets | 20 per day, 2 per tick. Line caps 800 / 1,600 / 4,000 and character caps 60,000 / 100,000 / 200,000 (default / mid / high). | `SDG_REVIEW_MAX_DAY`, `SDG_REVIEW_MAX_LINES`, `SDG_REVIEW_MAX_LINES_MID`, `SDG_REVIEW_MAX_LINES_HIGH`. Tick and character caps are literals. |
| Score gate and round budget | Pass at 8, cap at round 10 | `SDG_REVIEW_PASS_SCORE`, `SDG_REVIEW_MAX_ROUNDS` |
| Fix-round budgets | 4 per day, 2 per PR per day, 1 per tick | `SDG_FIXROUND_MAX_DAY`. The per-PR and per-tick caps are literals. |
| Claude quota ceiling | Fail over at 90% of a 40,000,000-token 5-hour window | `SDG_QUOTA_PCT`, `SDG_CLAUDE_5H_TOKEN_LIMIT` (environment, or `quota.env` in the state root). Without a valid limit the proactive layer is off and only the reactive layer works. |
| Quota gauge scope | The Claude config directories on this host that have a `projects/` directory (the cron home and the owner's VPS home) | `SDG_CCUSAGE_DIRS` (comma-separated) |
| Burn-rate alarm | Above $20 per hour, once the block has cost at least $1 | `SDG_BURN_ALERT_USD_HR`, `SDG_BURN_ALERT_MIN_USD` |
| Failover engine | `openai/gpt-6.1-sol` via OpenCode, 5-hour reactive block | `QUOTA_FALLBACK_MODEL` and `QUOTA_BLOCK_TTL` literals in `lib-quota.sh`. The limit-error pattern `QUOTA_LIMIT_RE` is a literal too. |
| Kill switches | `review-off`, `fixround-off` in the state root | Literal paths in `sdg-autoreview.sh` and `sdg-fixround.sh` |
| Test command | `npm test` (after `npm ci`) | Engine prompts, conflict repair, the fix-round orchestrator test run and its pass/fail parser |
| Proxy port | `8789` | `SDG_AUTOPR_PORT` in creation. A literal in conflict repair. |
| Notification channel | Review channel for the four `sdg-*` pipeline jobs. Direct messages for the watchdog. | Each Hermes cron entry's `deliver` field |

Every adaptation must use its own state root. Logs, quota counts, locks,
the kill switches, the `done-<pr>` review ledgers, the `rounds-<pr>` round
budgets, and the `findings-<pr>.json` files all live there. PR numbers are
repository-local, so a ledger shared with another repository would contain
`done-<n>` entries for numbers the new repository has not reviewed yet, and
would silently suppress those reviews. Shared `rounds-<n>` files would
spend the new repository's round budgets before its first review. A shared root would
also merge quota counts and circuit-breaker state across projects, and would
make one project's locks and kill switch stop the other.

### Bring-up checklist

Enable consumers before producers, so that nothing is created that cannot
yet be reviewed or repaired.

1. **Labels.** Create all four label families (`status/*`, `type/*`,
   `priority/*`, `quality/*`) from `docs/LABELS.md`. If the copy in use
   still has the older bootstrap that renames legacy labels with
   `gh label edit`, it fails on a new repository, where those names do not
   exist. Create the `status/*` and `quality/*` labels directly instead:
   ```bash
   R=<owner>/<repo>
   for l in \
     "status/awaiting-ai-review:FBCA04:Bot-owned: PR created, queued for automated diff review (scorecard). Next: status/ai-reviewed." \
     "status/ai-reviewed:1D76DB:Bot-owned: AI scorecard posted (verdict, mergeability, findings). Awaiting human merge decision." \
     "status/conflict:D73A4A:Bot-owned: merge conflict detected; automated resolution in progress (max 2 attempts/day)." \
     "status/conflict-resolved:0E8A16:Bot-owned: conflict auto-resolved, branch merged with base; re-queuing for AI review." \
     "status/fix-round:A62D03:Bot-owned: automation is working through AI review findings on this PR; one commit per finding." \
     "quality/low:C2E0C6:Routine automated change; single-pass review, standard score gate. Default for daily PR stream." \
     "quality/mid:FBBC04:Meaningful change; full-strength review model regardless of diff size." \
     "quality/high:5319E7:Architectural or high-stakes; top model + max effort, multi-round score-gated loop."; do
     IFS=: read -r n c d <<<"$l"; gh label create "$n" -R "$R" --color "$c" --description "$d" --force
   done
   ```
   Then create the `type/*` and `priority/*` labels from `docs/LABELS.md`. Use
   `gh label create --force` for `type/bug`, `type/feature`, and `type/docs`
   if the repository's default labels have been removed.
2. **Repository rules.** Copy `CLAUDE.md` (the no-attribution rule and test
   command) and `.claude/skills/create-pr/SKILL.md` (branch name, title, and
   description template) into the new repository and adjust the test
   command.
3. **Parameters.** Set every value in the table above. Search the scripts
   for the old repository slug, assignee, and paths. No literal from this
   project may remain.
4. **State root.** Create a new, empty state root for this project and point
   every script at it. Confirm that no script still reads or writes
   `$H/.autopr-sdg`, and that the new root contains no `done-<pr>`,
   `rounds-<pr>`, or `findings-<pr>.json` files before review is enabled.
5. **Watchdog.** Enable it first and confirm that a run on a healthy host
   prints nothing.
6. **Review.** Create both kill-switch files (`review-off` and
   `fixround-off`) in the new state root, then enable the review and
   fix-round cron entries. The fix-round job consumes what the review
   produces, so it must exist before review runs, but it stays off until
   step 7. Open one test PR by hand that the pipeline would accept as its
   own: head branch under the configured prefix (`auto-pr/...`), base branch
   equal to the configured base branch, initial label
   `status/awaiting-ai-review` with `quality/low`, assigned to the
   configured owner, and a diff of at most 800 lines (a larger one is
   handed off without a review). Both selection conditions are required, not
   optional: the reviewer and the fix-round job ignore PRs whose head branch
   is not under the configured prefix, and Phase 0 of conflict repair
   ignores PRs not assigned to the configured assignee. A smoke test on any
   other branch or assignee proves nothing, because the job under test
   never selects it. Remove `review-off` and confirm that exactly one
   scorecard and one notification appear, that the ledger entry records the
   PR's head SHA, and that `rounds-<pr>` has one line. Keep the PR open for
   the next steps.
7. **Fix rounds.** If the step 6 review passed the gate, force one fix
   outcome. First disable the review cron entry (or set
   `SDG_REVIEW_PASS_SCORE=11` on it) so that a scheduled review tick cannot
   review the PR at the normal gate between the relabel and the manual run;
   `review-off` would not help, because it also blocks the manual run. Then
   move the PR back to `status/awaiting-ai-review`, delete its
   `done-<pr>`, and immediately run one review tick by hand with
   `SDG_REVIEW_PASS_SCORE=11`, which no score can reach. Restore the review
   cron entry once the PR is at `status/fix-round`. This is a
   bring-up-only exception to the rule that people do not set `status/*`
   labels, and it consumes one round of the PR's budget. Remove `fixround-off` and confirm, in order:
   the PR moves to `status/fix-round` with `findings-<pr>.json` written; one
   fix-round tick pushes commits and moves it to
   `status/awaiting-ai-review`; the next review tick posts a scorecard with
   the next round number. Then push a commit to the PR branch by hand while
   it is labeled `status/ai-reviewed`, and confirm that push detection
   re-queues it on the next review tick.
8. **Conflict repair.** Enable it. Reuse the PR from steps 6 and 7 once it
   is back at `status/ai-reviewed`; it already meets both the review and the
   conflict-repair conditions. Push a commit to the base branch that edits
   the same lines as the PR, so that the PR becomes `CONFLICTING`. Follow it
   through `status/conflict`, `status/conflict-resolved`, and
   `status/awaiting-ai-review`. Confirm that the review ledger entry was
   cleared, that `rounds-<pr>` was not, and that another scorecard was
   posted.
9. **Creation.** Enable it last, with a small plan and a low backlog gate.
   Confirm the daily summary at the end of the first day, and that new PRs
   carry `status/awaiting-ai-review` and `quality/low`.

### Invariants

These properties carry the design. Do not change them when adapting the
pipeline.

| Invariant | Reason |
|---|---|
| One notification per unit of work, through one delivery path | Duplicate or missing messages make the channel useless as a monitor (5.1). A daily summary keeps silence meaningful. |
| Automation must never starve the owner's manual usage | The owner's paid work shares the Claude 5-hour window with the pipeline. There is a hard ceiling at 90% of the window, enforced by engine failover (Claude quota guard, section 2): past it, every Claude launch becomes a GPT launch on a separate quota. The ceiling applies to what the gauge can see on this host. Laptop usage is covered only reactively (section 4, known gaps). |
| Every guard that can stall a PR announces it once | A silent skip looks the same as an idle tick (5.9). Each stall posts one alert per unit of work, guarded by a marker file. Not yet true for every guard (`blueprint/LABELS.md` section 7). |
| Every automated path has a budget and an off switch | Automation multiplies tokens. A path without a cap is a cost incident waiting to happen. Marker-file kill switches today: `review-off` and `fixround-off`. Creation and conflict repair are stopped through their cron entries. |
| Every loop has a per-work-unit lifetime budget, not only a daily one | A daily cap bounds spend per day, not per PR. The score-gated fix loop is bounded by `rounds-<pr>`, which counts every scored review of the PR, ever. |
| Automation never resets a budget; only a human does | A budget that the loop it bounds can reset bounds nothing. No fix push, conflict repair, or push detection touches `rounds-<pr>`. The owner grants a fresh budget explicitly, by deleting the file. |
| Phases are idempotent and converge over ticks | GitHub state is eventually consistent (5.8). Re-running a tick must never change labels back and forth or repeat paid work. Phase 0 must keep excluding in-flight labels. |
| Engine self-reports are verified | Check that the push landed, that HEAD matches the remote, that there are no conflict markers or attribution, that GitHub reports the PR as mergeable, and that the tests passed by running them in the orchestrator. The fix-round job does all of this and pushes itself; conflict repair does not yet run the tests. "Done" from an engine is a claim, not a result. |
| A human makes the merge decision | Review is diff-scoped. Its score decides whether the automation runs another fix round, never whether the PR merges. A `critical` verdict means "check this manually", not "this is true". |
| Zero AI attribution | Enforced in the engine prompts, the `includeCoAuthoredBy:false` setting on conflict-repair and fix-round runs, and creation's audit after the push, which strips trailers and cleans the PR title and body. Conflict repair rejects a last commit message that mentions attribution. The fix-round job checks the message, author, and committer of every new commit before it pushes. |
| `status/*` labels are owned by the automation | Humans read lifecycle labels and do not set them. Otherwise the state machine cannot reason about them. A human who wants more changes pushes commits and lets push detection re-queue the PR. The labels describe automation state, not merge permission: the owner may merge any PR at any time. People will still edit labels by mistake; see "Designing for human error" below. |
| No state a human can create stalls silently | Every such state either converges back to a valid state or announces itself. See "Designing for human error" below. |
| Every transition removes the lifecycle labels it supersedes | Stacked labels force every reader to apply a precedence rule. Review, push detection, and fix rounds follow this. Conflict repair removes only `status/awaiting-ai-review` so far (section 3). |
| Engine input is bounded | Review sees the diff and description, never the repository. Every input has a cap. |
| Shared checkouts sit behind one lock, and every other job has its own worktree | Two jobs in one checkout destroy each other's work. |

### Designing for human error

The owner is human and makes mistakes. Manual label edits, lost labels,
pushes to a branch the automation is working on, and beginner mistakes are
expected, not exceptional. The contract: every state a person can create by
accident must either converge back to a valid state on its own, or announce
itself loudly. It must never stall in silence.

Current implementation of this law:

| Mechanism | Human error it covers | Converges or announces |
|---|---|---|
| Label reconciler (patrol Phase 3) | A `status/*` label removed by hand or lost by a dead tick | Converges: restores `status/fix-round` if a findings file exists, otherwise re-enters the pipeline at `status/awaiting-ai-review`. A `status/fix-round` without a findings file is announced once per PR and left to the human. |
| Worktree self-freeing (conflict repair, fix rounds) | A worktree left behind by a manual or orchestrator session that has the PR branch checked out | Converges and announces: the worktree is force-removed with a 🧹 line, or a "manual cleanup needed" alert if that fails (5.9). |
| Stall alerts | A PR stuck at the fix-round attempt cap, or a queue stuck behind a spent review budget | Announces: one alert per PR per day, or one per day. |
| Push detection (review Phase 0) | Commits pushed to a PR after its review | Converges: the PR is re-queued and the new code state is reviewed. |
| Ledger recovery (T6 in `blueprint/LABELS.md`) | A tick killed after the ledger write, before the label change | Converges: the recorded outcome is re-applied from the ledger, without a second review. |
| Label hygiene | A stale lifecycle label left next to the current one | Converges: review, push-detection, and fix-round transitions remove every label their target state excludes. |
| Alert lines and hand-off comments | States the machine must not decide: an oversize PR, a failed review, a cap reached, a manual fix round | Announces: a PR comment, a channel line, or both. |

Where the law is not met yet, honestly:

- A PR handed off for size, or whose review failed, has a ledger entry
  without a SHA. Pushes to it are not re-queued, and after the one
  announcement nothing further is said.
- A transition that GitHub keeps deferring (5.8) is visible only in the
  patrol log.
- A `status/ai-reviewed` left next to the conflict labels converges only at
  the next review transition. The reconciler does not resolve
  contradictory labels, only missing ones.
- A PR that conflicts while in `status/fix-round` ends up with
  `status/fix-round` and `status/awaiting-ai-review` after conflict repair.
  Both the reviewer and the fix-round job skip it, and nothing announces
  it (section 3, label hygiene).
- The conflict-repair attempt cap still stalls a PR until the next day with
  only a log line.

A new automated path is not finished until its human-error states are
listed and each one either converges or announces.

### Change policy

The label scheme, this blueprint, both label documents, and the scripts
form one contract.

- Change them only on explicit request from the repository owner, never as
  an incidental cleanup.
- When one changes, update all of them in one atomic pass: the GitHub labels,
  `sdg-autopr.sh`, `sdg-autoreview.sh`, `sdg-fixround.sh`,
  `sdg-conflict-patrol.sh`, `.claude/skills/create-pr/SKILL.md`,
  `docs/LABELS.md`, `blueprint/LABELS.md`, this document, and the runbook.
- Keep the two label documents consistent. `docs/LABELS.md` holds the
  canonical names, colors, descriptions, and the `gh` bootstrap for new
  repositories. `blueprint/LABELS.md` holds the movement view: owners,
  routines, transitions, and guards. A label or transition added to one is
  added to the other in the same change, and the lifecycle diagram in
  `blueprint/LABELS.md` stays literally identical to the one in section 3.
- Before shipping a change to a guard, replay the historical logs against it
  to see what it would have blocked or allowed.
- When this document and the scripts disagree, the scripts describe what the
  pipeline actually does. Fix whichever one is wrong, in the same pass.
