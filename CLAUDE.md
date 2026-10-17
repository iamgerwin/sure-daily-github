# CLAUDE.md

## Commits — HARD RULE

- NEVER add AI attributions to commits. This means NO `Co-Authored-By: Claude` trailers, NO `🤖 Generated with [Claude Code](...)` footers, NO mention of Claude/Anthropic/AI anywhere in commit messages, PR titles, or PR descriptions.
- Every commit must be plain, conventional-style messages (e.g. `fix: ...`, `feat: ...`, `docs: ...`) authored only as the configured git user.
- If using `git commit` directly, do NOT pass `--trailer` or any attribution flags, and never let tooling append them on your behalf.

## Pull Requests — MANDATORY

- Every PR opened on this repo MUST use the `create-pr` skill (`.claude/skills/create-pr/SKILL.md`): branch naming, title, description template, and `gh` flags.

## Project

Node.js tool. Test suite: `npm test` (`node --test`). Keep changes minimal and behavior-focused; follow the commit message style in `git log`.

## Conflict Fixer (fix-conflicts)

- `fix-conflicts` scans configured repos' open PRs and auto-resolves merge conflicts (newer change per hunk) behind a mandatory test gate. It pushes nothing unless the target repo's tests pass and the repo is explicitly allowed (`conflictFixer` block: allowlist/denylist/per-repo; default is allowlist-empty = nothing runs).
- Full spec: docs/CONFLICT_FIXER.md — read it before touching src/core/conflict-fixer.js, src/core/conflict-resolver.js, or src/utils/fixer-ledger.js.
- Idempotent by design (run lock + per-PR headSHA ledger); never add a code path that bypasses the test gate, the repo gate, or the ledger.
