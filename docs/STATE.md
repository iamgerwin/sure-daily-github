# State Management

sure-daily-github tracks activity per repository with hourly, daily, and weekly counters to avoid exceeding configured limits and to produce organic patterns.

## How It Works

- Per repository counters stored in `data/state.json`:
  - hourly: `YYYY-MM-DDTHH`
  - daily: `YYYY-MM-DD`
  - weekly: ISO week key `YYYY-Www`
- Totals
  - `totals.issues`, `totals.commits`
- Entries are keyed by `owner/repo`. GitHub names are case-insensitive, so when the configured casing changes (for example `Me/Demo` to `me/demo`), the existing entry is moved to the new key and keeps its counters instead of starting from zero. The advanced issue handler's `data/issue-state.json` does the same, so a re-cased repository keeps today's issue count, target and pending interval.
- Backward compatibility
  - Legacy fields `lastCommitDate`, `commitsToday`, `totalCommits` are maintained. `lastCommitDate` is the timezone-local date of the most recent recorded commit (`null` until the first commit); it does not change when a new day's window opens.

## Timezone

All windows respect `general.timezone` from your configuration (default: `UTC`). This impacts boundary resets for hourly/daily/weekly periods.

## Limits

Limits are evaluated before each action:

- When `randomization.timeVariations.enabled: true`, the `max` values for `hourly`, `daily`, and `weekly` are treated as hard caps.
- In issue mode with fixed targets (the simple issue handler) and `randomization.enabled: true`, the daily cap is `timeVariations.daily.max` when time variations are enabled, otherwise `randomization.issueCount.max`; the repository `dailyTarget` is not used.
- Otherwise, the repository `dailyTarget` (number or range) determines the daily cap.
- A dry run of the simple issue handler records nothing, so when one run rolls several issues it previews only as many as the hourly, daily, and weekly caps still allow, then reports the rest as `limit_reached`, the same as a real run.
- A `dailyTarget` range (`{ min, max }`) in commit mode rolls one target per repository per day, stored as `dailyTarget: { day, min, max, value }` in that repository's state, so every run that day and `status` use the same value. A new day or a changed range rolls a new target.
- In issue mode with range targets or `intervalMinutes` (the advanced issue handler, state in `data/issue-state.json`), each repository's entry stores `todayTarget` and the `targetRange: { min, max }` it was rolled from. Changing the configured range during the day rolls a new `todayTarget` on the next run; issues already created today still count toward it. Entries written before `targetRange` existed keep their target if it still lies within the configured range.
- The advanced issue handler's daily reset clears each repository's `issuesCreatedToday`, `todayTarget`, and `targetRange`, but keeps `lastIssueTime` and `nextIssueTime`, so an issue created shortly before midnight still delays the next one by its `intervalMinutes`. `status` shows a previous day's `nextIssueTime` while it is still in the future. Its Next Issue column shows `HH:MM` in `general.timezone`, prefixed with the date (`YYYY-MM-DD HH:MM`) when the next issue falls on a later day.

## Graceful Fallbacks

- If the state file is missing or corrupted, the system starts fresh and keeps a `.bak` backup (when possible).
- A state file that is valid JSON but not an object (for example `[]`) is treated the same way: it is copied to `.bak` before starting fresh. A `repositories` section that is not an object is reset to empty after the same `.bak` backup, and the rest of the file (such as the round-robin cursor `roundRobin`) is kept.
- A repository entry, counter window, or total with the wrong shape (for example a hand edit that drops `count`) is reset to its default on its own; the rest of the state is kept. The same applies to the legacy fields: a `commitsToday` or `totalCommits` that is not a non-negative whole number resets to `0`, and a `lastCommitDate` that is not a string resets to `null`.
- The same applies to `data/issue-state.json`: a file that is not a JSON object is backed up as `issue-state.json.corrupt-<time>` and started fresh, a `repositories` section that is not an object is replaced with an empty one, and a repository entry that is not an object or has a missing or invalid `issuesCreatedToday` starts from zero, so the daily target is still enforced.
- The directory structure is created on demand.
- If `data/state.json` cannot be written (read-only mount, permissions, full disk), the commit or issue is reported as failed with `Could not save state to <path>: <reason>`, so `run` exits `1`. The state file is written once before the GitHub API call, so an unwritable file stops the action before anything is created. Otherwise every later run would reload the old counts and create another commit or issue, never reaching the daily target. If the save after the API call fails anyway (for example, the disk fills in between), the action is reported as failed and its count is rolled back in memory, so a later save in the same run does not persist it. A failure to save a newly rolled `dailyTarget` range value is only logged, so `status` still works on a read-only state file; the next process rolls the value again.
- Legacy methods `isCommitNeeded` and `recordCommit` are still supported and map to daily limits to preserve original behavior.

## Overriding State Path

Set `SDG_STATE_FILE` to change where state is stored (useful for testing or custom deployments):

```bash
export SDG_STATE_FILE=/var/lib/sure-daily-github/state.json
```

It can also be set in `.env` (read from the working directory); a variable already set in the environment takes precedence.

The advanced issue handler keeps its own file, `data/issue-state.json`; set `SDG_ISSUE_STATE_FILE` to move it:

```bash
export SDG_ISSUE_STATE_FILE=/var/lib/sure-daily-github/issue-state.json
```

The other commands' state files have their own overrides, documented with each command: `SDG_BABYSITTER_STATE_FILE` ([BABYSIT.md](BABYSIT.md)), `SDG_CONFLICT_FIXER_STATE_FILE` ([CONFLICT_FIXER.md](CONFLICT_FIXER.md)), and `SDG_PR_MAINT_STATE_FILE`, `SDG_PR_MAINT_LOCK_FILE` and `SDG_PR_MAINT_DECISIONS_FILE` ([PR_MAINTENANCE.md](PR_MAINTENANCE.md)).

## Concurrent Runs

Every execution holds an exclusive lock file (`data/run.lock`) for its whole duration, so the scheduler service and a manual `node src/cli.js run` cannot update the state files at the same time. If another live process holds the lock, the run is skipped: `run` exits with an error that shows the holder's PID, and the scheduler logs a warning and waits for the next tick.

A lock left behind by a crashed process is reclaimed automatically when its PID is no longer alive. A lock older than 2 hours is also reclaimed, in case the PID has been reused.

```bash
export SDG_RUN_LOCK_FILE=/var/lib/sure-daily-github/run.lock   # lock location
export SDG_RUN_LOCK_STALE_MS=7200000                           # age after which a lock is reclaimed
```

## Testing

Run unit tests covering state logic and window resets:

```bash
npm test
```
