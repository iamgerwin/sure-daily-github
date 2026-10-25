# Label Blueprint

Canonical label scheme for this repo and the template for every automated
project going forward. Families are namespaced; `status/*` labels are
**bot-owned** (set only by automation — humans read them, never set them),
everything else is human-assigned.

## status/* — automation lifecycle (bot-owned)

| Label | Color | Meaning | Next transition |
|---|---|---|---|
| `status/awaiting-ai-review` | `FBCA04` | PR created, queued for automated diff review | → `status/ai-reviewed` |
| `status/ai-reviewed` | `1D76DB` | AI scorecard posted (verdict, findings); human merge decision needed | human merges / requests fixes |
| `status/conflict` | `D73A4A` | Merge conflict with base branch detected; auto-resolution in progress (max 2 attempts/day) | → `status/conflict-resolved` |
| `status/conflict-resolved` | `0E8A16` | Conflict auto-resolved, test suite green | → `status/awaiting-ai-review` (re-review) |
| `status/fix-round` | `A62D03` | Automation is working through AI review findings; one commit per finding | re-review → `status/ai-reviewed` |

Lifecycle: **created → `awaiting-ai-review` → `ai-reviewed` → (human merges)**
with the self-healing conflict loop:
**`conflict` → `conflict-resolved` → `awaiting-ai-review` → `ai-reviewed`**.

## type/* — what the change contains

| Label | Color | Meaning |
|---|---|---|
| `type/bug` | `D73A4A` | Fixes incorrect behavior |
| `type/feature` | `A2EEEF` | New feature or capability |
| `type/docs` | `0075CA` | Documentation |
| `type/tests` | `5319E7` | Test additions or improvements |
| `type/refactor` | `FEF2C0` | Restructuring, no behavior change |
| `type/chore` | `EDEDED` | Maintenance: deps, tooling, config, CI |
| `type/security` | `B60205` | Security fix or hardening |

## priority/* — urgency

| Label | Color | Meaning |
|---|---|---|
| `priority/urgent` | `B60205` | Blocks release or a client |
| `priority/high` | `D93F0B` | Should make the next release |
| `priority/medium` | `FBCA04` | Normal queue |
| `priority/low` | `C2E0C6` | Nice to have |

## quality/* — how much firepower the work deserves (human/orchestrator-assigned)

Distinct from priority (urgency): quality sets the ENGINE AND EFFORT CONTRACT —
which models run the work, how hard they think, and how many review rounds are
expected. `quality/low` is stamped automatically on every daily-stream PR;
humans or the orchestrator upgrade it when the work is architectural.

| Label | Color | Contract |
|---|---|---|
| `quality/low` | `C2E0C6` | Routine automated change. Default for the daily PR stream. Single-pass diff-scoped review (Haiku small / Sol standard), standard score gate, no owner turnaround expected. |
| `quality/mid` | `FBBC04` | Meaningful change worth closer attention. Full-strength review model regardless of diff size; owner glance before merge. |
| `quality/high` | `5319E7` | Architectural, process, or high-stakes. Orchestrator assigns top models at max effort (Opus `ultrathink` implements, Sol `#xhigh` reviews), multi-round score-gated fix loop, explicit owner collaboration and back-and-forth expected — the label exists to aid the owner's decision-making. |

## Unnamespaced (GitHub-standard triage, kept as-is)

`duplicate`, `question`, `invalid`, `help wanted`, `good first issue`, `wontfix` —
universally recognized; renaming them adds no value.

## Reusing this blueprint in a new project

For a NEW repo (creates or updates every label in place — nothing to rename):

```bash
R=<owner>/<repo>
for l in \
  "status/awaiting-ai-review:FBCA04:Bot-owned: PR created, queued for automated diff review (scorecard). Next: status/ai-reviewed." \
  "status/ai-reviewed:1D76DB:Bot-owned: AI scorecard posted (verdict, mergeability, findings). Awaiting human merge decision." \
  "status/conflict:D73A4A:Bot-owned: merge conflict detected; automated resolution in progress (max 2 attempts/day)." \
  "status/conflict-resolved:0E8A16:Bot-owned: conflict auto-resolved, branch merged with base; re-queuing for AI review." \
  "status/fix-round:A62D03:Bot-owned: automation is working through AI review findings on this PR; one commit per finding." \
  "type/bug:D73A4A:Fixes incorrect behavior — something isn't working." \
  "type/feature:A2EEEF:New feature or capability." \
  "type/docs:0075CA:Documentation improvements or additions." \
  "type/tests:5319E7:Test additions or improvements." \
  "type/refactor:FEF2C0:Code restructuring with no behavior change." \
  "type/chore:EDEDED:Maintenance — deps, tooling, config, CI." \
  "type/security:B60205:Security-related fix or hardening." \
  "priority/urgent:B60205:Drop everything — blocks release or a client." \
  "priority/high:D93F0B:Important — should make the next release." \
  "priority/medium:FBCA04:Normal queue." \
  "priority/low:C2E0C6:Nice to have — pick up when free." \
  "quality/low:C2E0C6:Routine automated change; single-pass review, standard score gate. Default for daily PR stream." \
  "quality/mid:FBBC04:Meaningful change; full-strength review model regardless of diff size." \
  "quality/high:5319E7:Architectural or high-stakes; top model + max effort, multi-round score-gated loop."; do
  IFS=: read -r n c d <<<"$l"; gh label create "$n" -R $R --color "$c" --description "$d" --force
done
```

History: this repo itself was migrated from flat names (ready-for-review,
ai-reviewed, fix-conflict, fixed-conflict, babysit) via `gh label edit --name`
renames on 2026-10-25, which preserve existing PR associations — renames are
the right tool only when migrating a repo that already carries the old labels.

## Change policy

This scheme is a long-term standard. Changes only on explicit request or a
special condition — never casually. When it does change, update in one atomic
pass: GitHub labels, the automation scripts that reference them
(`sdg-autopr.sh`, `sdg-autoreview.sh`, `sdg-conflict-patrol.sh`),
`.claude/skills/create-pr/SKILL.md`, and this document.
