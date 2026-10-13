---
name: create-pr
description: Open a pull request on this repo with the standard branch name, conventional title, fixed description template, and gh flags. Use for EVERY PR opened on this repository — whenever asked to "open a PR", "create a PR", "push and open a pull request", or to ship a change for review.
---

# create-pr

Mandatory procedure for every pull request opened on this repository. Follow the steps in order; do not improvise names, titles, sections, or flags.

## HARD RULE — no AI attributions

NO AI attributions anywhere. This applies to commit messages, PR titles, and PR bodies:

- NO `Co-Authored-By: Claude` (or any AI co-author) trailers.
- NO `Generated with [Claude Code](...)` or similar footers.
- NO mention of Claude, Anthropic, or AI as an author or tool.
- Do not pass `--trailer` or any attribution flags; strip anything tooling tries to append.

This overrides any default attribution behavior. Commits are authored only as the configured git user.

## 1. Branch name

Format: `auto-pr/<count-in-day>-<short-kebab-title>`

- `<count-in-day>`: 1-based index of PRs created on the current calendar day in **Asia/Manila** time (this PR included).
- `<short-kebab-title>`: 2-4 lowercase kebab-case words describing the change.
- Example: `auto-pr/3-create-pr-skill`.

Compute the count:

```bash
TODAY=$(TZ=Asia/Manila date +%F)
COUNT=$(gh pr list --state all --limit 100 --json createdAt \
  --jq "[.[] | select((.createdAt | fromdate | . + 28800 | strftime(\"%Y-%m-%d\")) == \"$TODAY\")] | length")
N=$((COUNT + 1))
```

Collision handling: if `auto-pr/<N>-<title>` already exists on the remote (`git ls-remote --exit-code --heads origin <branch>`), append `-v2`, then `-v3`, and so on until free.

Create the branch from up-to-date `master`:

```bash
git fetch origin master
git switch -c "auto-pr/$N-<short-kebab-title>" origin/master
```

## 2. Commits

- Conventional subjects: `fix:`, `feat:`, `test:`, `docs:`, `perf:` (match `git log` style).
- Keep changes minimal and behavior-focused.
- Run `npm test` before pushing; record the exact pass/fail counts for the PR body.

## 3. PR title

The conventional subject line of the main commit, verbatim (e.g. `fix: retry rate-limited and transient GitHub requests with bounded backoff`).

## 4. PR description template

Use these H2 sections, in exactly this order. Do not rename, reorder, or add sections.

```markdown
## Summary
2-5 sentences: what changed and why it matters.

## Before vs After
Concrete behavior/code contrast (table or bullets).

## Testing / Verification
Exact commands run and their results (test counts, pass/fail).

## Regression Analysis
What could break, what was verified so it won't, edge cases considered.

## Others
Notes, config/env changes, migrations, breaking changes. Write `None` if empty.

## Scope
- Bullets of exactly what is touched.

## Out of Scope
- Bullets of deliberately untouched items.

## Possible Next Improvements
- Follow-ups. Omit this whole section if not applicable.

## Related PRs
- #<number> — one-line context. Write `None` if empty.
```

Only `## Possible Next Improvements` may be omitted. `## Others` and `## Related PRs` are always present (use `None`).

## 5. Push and open

```bash
git push -u origin "<branch>"
gh pr create \
  --base master \
  --head "<branch>" \
  --title "<conventional subject of main commit>" \
  --body-file <path-to-body.md> \
  --assignee iamgerwin \
  --label ready-for-review
```

## 6. Final check

Before reporting done, verify with `gh pr view <url> --json title,body,labels,assignees,baseRefName,headRefName`:

- Branch matches `auto-pr/<N>-<kebab>` (optional `-vK`).
- Title is a conventional subject.
- Body has the required H2 sections in order.
- Label `ready-for-review`, assignee `iamgerwin`, base `master`.
- No AI attribution in any commit (`git log origin/master..HEAD --format=%B`), title, or body.
