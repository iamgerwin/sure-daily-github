# PR Maintenance

This page covers `pr-maint`, the PR lifecycle orchestrator, and the CI and branch-protection setup it relies on. The
automation will resolve conflicts, address review findings, and merge PRs that pass the merge policy. Nothing may be
merged automatically until the test suite runs on every PR and `master` requires it to pass.

## `pr-maint`

`sure-daily-github pr-maint` runs one tick: it reads every open PR, decides which labels, status and sticky comment each
one should have, and sends every write through a policy check before it reaches GitHub. It never merges, and it doesn't
run any AI worker yet.

### What's implemented, and what isn't yet

| Implemented | Not implemented yet (later PRs) |
|---|---|
| Lifecycle labels (`sdg:conflict`, `sdg:waiting`), `needs-human` add/clear rules | Conflict resolution by a worker and its verifier (`sdg:conflict` is only reported) |
| Sticky status comment per PR, dashboard issue | Review-finding fixes, thread replies, `/sdg` commands (`sdg:fixing`) |
| `sdg/merge-policy` commit status, as a `pending` placeholder only | The merge policy verdict (`success`/`failure`), the scorecard, `sdg:ready` |
| Policy engine, rate caps, circuit breaker, decisions log | Merges, the post-merge gate, auto-revert, the merge freeze |
| | Claude run, push and merge budgets (configured and validated, but nothing spends them yet) |

`sdg:fixing` and `sdg:ready` are kept as found. Nothing in this release adds them.

### Running it

The tick is meant to run from cron every 5 minutes on the host that holds the GitHub token:

```cron
*/5 * * * * cd /path/to/sure-daily-github && node src/cli.js pr-maint --once >> logs/pr-maint.log 2>&1
```

| Flag | Effect |
|---|---|
| `--mode shadow\|act\|autonomous` | Overrides `prMaint.mode` for this tick |
| `--repo <owner/repo>` | Restricts the tick to a configured repository (repeatable) |
| `--pr <N>` | Only PR N gets actions; the dashboard still lists every PR. Needs exactly one `--repo` |
| `--once` | Runs one tick and exits. This is also the default |
| `--dry-run` | Decides and prints the planned actions and policy verdicts. Writes nothing: no GitHub writes, no state file, no decisions log |

A tick takes its own lock, `data/pr-maint.lock`, separate from the `run.lock` that `run`, `babysit` and `fix-conflicts`
share. A tick still running when cron fires again makes the new one exit 0 without doing anything.

### Configuration

```yaml
prMaint:
  enabled: true          # default false; a disabled tick only runs with --dry-run
  mode: shadow           # shadow | act | autonomous
  authors: [iamgerwin]   # only PRs by these logins are maintained
  rateLimits:
    writesPerPrPerTick: 20
    writesPerHour: 200
  budgets:               # validated now, enforced once workers and merges land
    claudeRunsPerPrPerDay: 6
    claudeRunsPerDay: 40
    pushesPerPrPerDay: 4
    mergesPerDay: 3
```

A repository is only touched if the `conflictFixer` repository gate allows it (see [CONFLICT_FIXER.md](CONFLICT_FIXER.md)).
With the default empty allowlist, `pr-maint` reads and writes nothing.

### Modes

| Mode | Writes allowed |
|---|---|
| `shadow` (default) | Only the dashboard issue. Every other planned write is logged as denied (`rule: mode`), and the dashboard's **Pending** column shows the label changes act mode would make |
| `act` | Labels, sticky comments, `sdg/merge-policy` statuses, and the dashboard |
| `autonomous` | The same as `act` in this release. Merges arrive in a later PR |

Shadow mode is safe by construction, with three independent layers: the policy's mode rule, an executor guard that
refuses anything but the dashboard upsert whatever the policy table says, and a handler table that only contains the
dashboard handler. Shadow mode also never creates labels, and never re-reads PRs for the head pin.

### Tick

```
1 lock       data/pr-maint.lock (exit 0 when held)
2 gates      prMaint.enabled, conflictFixer repo gate, dashboard issue labeled automation-paused → stop
3 snapshot   one GraphQL query per 50 open PRs: head, mergeable, labels, review threads, reviews, check contexts
4 decide     pure decide(snapshot, ledger) → planned actions per PR (babysit PRs first)
5 execute    every action: policy.check → handler → data/pr-maint-decisions.jsonl
6 dashboard  re-rendered after the PRs (so a breaker trip this tick shows), read back from GitHub, written only when
             the issue is missing, closed, not ours, or its body differs
7 ledger     data/pr-maint-state.json
```

**Fingerprint.** A PR is only decided again when
`sha1(headSha, mergeable, mergeStateStatus, checks, thread ids + last comment ids, review ids, labels − managed labels)`
changes, the mode changes, or its managed labels differ from what the ledger recorded after our own last writes (so a
managed label someone else added or removed is reconciled). `checks` is computed from the check contexts *without*
`sdg/merge-policy`, and the sticky comment isn't part of the snapshot, so none of our own writes wake a PR. An idle tick
costs one GraphQL query, one dashboard read, and no writes.

**Idempotency.** GitHub is the source of truth. Labels are compared against the snapshot. The status is only posted when
the head commit has no `sdg/merge-policy` context, and an existing one is never overwritten. The sticky and the dashboard
are found by marker (and must be authored by the token's user), then edited only when their body changed. If you delete
`data/pr-maint-state.json`, the next tick costs extra reads but makes no duplicate writes. The one exception is escalation
records, which live only in the state file in this release.

### Label state machine

Labels are created (or repaired, for the AI-owned ones) on the first `act` tick. Each of those writes is admitted like an
action (hourly cap, breaker, decisions log as `type: setup`); a setup cut short is finished on a later tick:

| Label | Added by | Removed by | Meaning |
|---|---|---|---|
| `sdg:conflict` | AI | AI | Lifecycle: resolving merge conflicts |
| `sdg:fixing` | AI (later PR) | AI | Lifecycle: addressing review findings or scorecard gaps |
| `sdg:waiting` | AI | AI | Lifecycle: waiting on CI, re-review, quiet period or quarantine |
| `sdg:ready` | AI (later PR) | AI | Lifecycle: every merge gate passes |
| `conflict-resolved` | AI (later PR) | AI | History flag: the AI resolved a conflict, so quarantine applies |
| `needs-human` | AI or human | AI when its clearing condition holds; human anytime | Escalated; reason and clearing condition are in the sticky |
| `babysit` | human | human | Priority hint: handled first |
| `automation-paused` | human | human | Kill switch: on a PR, that PR is skipped; on the dashboard issue, everything stops |

Transitions in this release:

```
[automation-paused] on the PR                  ⇒ skipped, no actions
fork head branch / author not in prMaint.authors ⇒ skipped
mergeable CONFLICTING or mergeState DIRTY      ⇒ sdg:conflict (other lifecycle labels removed first)
sdg:conflict, no longer conflicting (a push)   ⇒ sdg:waiting
no lifecycle label, not conflicting            ⇒ sdg:waiting
mergeable UNKNOWN                              ⇒ no label change; re-checked next tick
two lifecycle labels                           ⇒ the extra one is removed
needs-human present                            ⇒ frozen: only the sticky comment changes
```

**`needs-human`.** A label without an escalation record was set by a human, and the AI never removes it. An escalation
the AI recorded is cleared automatically when its condition holds, for example a new head for `attempts` or `uncertain`,
or no longer conflicting for `non-text` or `lockfile` (GitHub must report `MERGEABLE` with a computed merge state;
`UNKNOWN` keeps the label). That happens at most twice per PR in 7 days. The allowlisted conditions live in `policy.js`,
and the `needs-human` rule enforces them again on the live PR (mergeability, and checks for `tests-red`) right before the
write; any other reason waits for a human. A pending escalation whose `needs-human` is already on GitHub is acknowledged
in the ledger before anything else is decided, so a crash after the label write can't override a later human clear. The
third escalation in 7 days sticks as `flapping`. `policy-denial`, `gate-weakening` and `flapping` are cleared by humans only. The first
escalation mentions the owner once in the sticky comment. That's the only `@`-mention the automation ever writes.

### Policy engine

`src/core/policy.js` is a pure, ordered rule table. Each action (`label.add`, `label.remove`, `comment.upsert`,
`thread.resolve`, `status.post`) is checked against every rule, and the first denial wins:

| Rule | Kind | Denies |
|---|---|---|
| `type` | impossible | unknown action types or scopes |
| `scope` | impossible | forks, non-allowlisted authors, anything but the body upsert on the dashboard, other status contexts, threads from another PR |
| `labels` | impossible | labels outside the managed set, including `babysit` and `automation-paused` |
| `text-safety` | impossible | attribution (`Co-Authored-By`, `Generated with`, `Claude`, `Anthropic`, the robot emoji) and secret patterns |
| `text-format` | deny | comments without their marker, a leading `/sdg`, `@`-mentions of anyone but the owner, text over 8 KB, status descriptions over 140 characters |
| `status` | deny | any `sdg/merge-policy` state other than `pending` (the real verdict comes with the merge policy) |
| `lifecycle` | deny | a second lifecycle label |
| `needs-human` | deny | removing a human-set `needs-human`, a human-only or unrecognized reason, a clearing condition that doesn't hold on the live PR, or a third auto-clear in 7 days |
| `escalated` | deny | anything but the sticky and `needs-human` on an escalated PR |
| `thread` | deny | resolving a resolved thread, or an owner thread that isn't fixed |
| `mode` | deny | anything but the dashboard in shadow mode |
| `paused` | deny | writes to a PR labeled `automation-paused` |
| `rate` | trip | more than 20 writes on a PR in a tick, or 200 writes in an hour (creating the dashboard reserves both of its writes) |
| `head-pin` | deny | the PR's head moved (re-read right before the write in act mode) or the PR closed |

Content rules run before the mode rule, so shadow mode still surfaces impossible denials. A denial is logged and never
retried in the same tick. `head-pin` and `rate` denials leave the PR to be decided again next tick.

**Circuit breaker.** An *impossible* denial escalates the PR (`needs-human`, reason `policy-denial`) and trips the breaker.
So does a `rate` denial, which doesn't escalate. A trip drops the mode one level (autonomous → act → shadow) for 24
hours, effective immediately for the rest of the tick. The dashboard shows it.

**Decisions log.** `data/pr-maint-decisions.jsonl` gets one line per planned action: time, repository, PR, type, head,
mode, verdict, rule, reason and outcome. Comment bodies are stored only as a SHA-1 and a byte count. In shadow mode this
log is the dataset you review before promoting to `act`.

### Dashboard and sticky comment

- **Dashboard issue** "sdg: PR automation", marker `<!-- sdg:dashboard -->`, pinned when created. It shows the mode (and
  the configured mode if the breaker lowered it), the rate caps, the breaker state, and one row per open PR: state, next
  step, blocker and pending label changes. To pause everything, label this issue `automation-paused`. It is capped at
  50 rows and 8 KB (UTF-8), with the number of PRs left out and a link to the PR list. A dashboard that can't be
  published fails the tick (exit 1), is logged as an error, and gets a `dashboard.publish` line in the decisions log.
- **Sticky comment** per PR, marker `<!-- sdg:status -->`: lifecycle state, why, next step, mode, head, priority, and the
  escalation with its `<!-- sdg:escalation reason=… clear=… n=… -->` record. It has no timestamps, so it's only edited
  when something changed.

## CI workflow

`.github/workflows/test.yml` runs on:

- every pull request targeting `master`
- every push to `master`

It has one job, `test`, on `ubuntu-latest`. The job checks out the repo, sets up Node.js 22 with the npm cache, installs
dependencies (`npm ci`, or `npm install` if there is no `package-lock.json`), and runs `npm test`.

The job name `test` is load-bearing: the `master` ruleset below requires a status check with exactly that name. If you
rename the job, required checks will never report and every PR will be blocked.

## One-time setup: `master` ruleset

**Apply this by hand, once. This PR does not apply it.** Run it after the CI workflow has landed on `master`:

```bash
gh api -X POST repos/iamgerwin/sure-daily-github/rulesets --input - <<'JSON'
{"name":"master","target":"branch","enforcement":"active",
 "conditions":{"ref_name":{"include":["~DEFAULT_BRANCH"],"exclude":[]}},
 "rules":[{"type":"deletion"},{"type":"non_fast_forward"},
  {"type":"pull_request","parameters":{"required_approving_review_count":0,"dismiss_stale_reviews_on_push":false,
    "require_code_owner_review":false,"require_last_push_approval":false,"required_review_thread_resolution":true}},
  {"type":"required_status_checks","parameters":{"strict_required_status_checks_policy":true,
    "required_status_checks":[{"context":"test"},{"context":"sdg/merge-policy"}]}}]}
JSON
```

The ruleset:

- blocks deleting `master` and force-pushing to it (`deletion`, `non_fast_forward`)
- requires every change to go through a pull request, with all review threads resolved
- requires the `test` check (this workflow) and the `sdg/merge-policy` commit status to pass on an up-to-date branch

The bypass list is empty, so admins don't get a bypass either. `sdg/merge-policy` is posted by `pr-maint`. In this
release it only posts a `pending` placeholder (in `act` mode or above), and the real verdict arrives with the merge
policy. Until then, PRs can't satisfy the ruleset. Apply the ruleset when the merge policy is ready, or expect merges to
be blocked until it is.

To check it after applying:

```bash
gh api repos/iamgerwin/sure-daily-github/rulesets
```
