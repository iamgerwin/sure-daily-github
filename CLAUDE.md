# CLAUDE.md

## Commits — HARD RULE

- NEVER add AI attributions to commits. This means NO `Co-Authored-By: Claude` trailers, NO `🤖 Generated with [Claude Code](...)` footers, NO mention of Claude/Anthropic/AI anywhere in commit messages, PR titles, or PR descriptions.
- Every commit must be plain, conventional-style messages (e.g. `fix: ...`, `feat: ...`, `docs: ...`) authored only as the configured git user.
- If using `git commit` directly, do NOT pass `--trailer` or any attribution flags, and never let tooling append them on your behalf.

## Project

Node.js tool. Test suite: `npm test` (`node --test`). Keep changes minimal and behavior-focused; follow the commit message style in `git log`.
