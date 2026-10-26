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
| `status/conflict-resolved` | `0E8A16` | Conflict auto-resolved: branch merged with base; mechanical checks only, tests not run | → `status/awaiting-ai-review` (re-review) |
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

## Unnamespaced (GitHub-standard triage, kept as-is)

`duplicate`, `question`, `invalid`, `help wanted`, `good first issue`, `wontfix` —
universally recognized; renaming them adds no value.

## Reusing this blueprint in a new project

```bash
R=<owner>/<repo>
gh label edit ready-for-review -R $R --name status/awaiting-ai-review --color FBCA04 --description "Bot-owned: PR created, queued for automated diff review (scorecard). Next: status/ai-reviewed."
gh label edit ai-reviewed -R $R --name status/ai-reviewed --color 1D76DB --description "Bot-owned: AI scorecard posted (verdict, mergeability, findings). Awaiting human merge decision."
gh label edit fix-conflict -R $R --name status/conflict --color D73A4A --description "Bot-owned: merge conflict detected; automated resolution in progress (max 2 attempts/day)."
gh label edit fixed-conflict -R $R --name status/conflict-resolved --color 0E8A16 --description "Bot-owned: conflict auto-resolved, branch merged with base; re-queuing for AI review."
gh label edit babysit -R $R --name status/fix-round --color A62D03 --description "Bot-owned: automation is working through AI review findings on this PR; one commit per finding."
gh label edit bug -R $R --name type/bug --color D73A4A --description "Fixes incorrect behavior — something isn't working."
gh label edit enhancement -R $R --name type/feature --color A2EEEF --description "New feature or capability."
gh label edit documentation -R $R --name type/docs --color 0075CA --description "Documentation improvements or additions."
for l in "type/tests:5319E7:Test additions or improvements." "type/refactor:FEF2C0:Code restructuring with no behavior change." "type/chore:EDEDED:Maintenance — deps, tooling, config, CI." "type/security:B60205:Security-related fix or hardening." "priority/urgent:B60205:Drop everything — blocks release or a client." "priority/high:D93F0B:Important — should make the next release." "priority/medium:FBCA04:Normal queue." "priority/low:C2E0C6:Nice to have — pick up when free."; do
  IFS=: read -r n c d <<<"$l"; gh label create "$n" -R $R --color "$c" --description "$d" --force
done
```

## Change policy

This scheme is a long-term standard. Changes only on explicit request or a
special condition — never casually. When it does change, update in one atomic
pass: GitHub labels, the automation scripts that reference them
(`sdg-autopr.sh`, `sdg-autoreview.sh`, `sdg-conflict-patrol.sh`),
`.claude/skills/create-pr/SKILL.md`, and this document.
