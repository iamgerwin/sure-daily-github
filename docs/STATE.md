# State Management

sure-daily-github tracks activity per repository with hourly, daily, and weekly counters to avoid exceeding configured limits and to produce organic patterns.

## How It Works

- Per repository counters stored in `data/state.json`:
  - hourly: `YYYY-MM-DDTHH`
  - daily: `YYYY-MM-DD`
  - weekly: ISO week key `YYYY-Www`
- Totals
  - `totals.issues`, `totals.commits`
- Backward compatibility
  - Legacy fields `lastCommitDate`, `commitsToday`, `totalCommits` are maintained. `lastCommitDate` is the timezone-local date of the most recent recorded commit (`null` until the first commit); it does not change when a new day's window opens.

## Timezone

All windows respect `general.timezone` from your configuration (default: `UTC`). This impacts boundary resets for hourly/daily/weekly periods.

## Limits

Limits are evaluated before each action:

- When `randomization.timeVariations.enabled: true`, the `max` values for `hourly`, `daily`, and `weekly` are treated as hard caps.
- Otherwise, the repository `dailyTarget` (number or range) determines the daily cap.

## Graceful Fallbacks

- If the state file is missing or corrupted, the system starts fresh and keeps a `.bak` backup (when possible).
- A repository entry, counter window, or total with the wrong shape (for example a hand edit that drops `count`) is reset to its default on its own; the rest of the state is kept.
- The directory structure is created on demand; failures are logged without crashing the process.
- Legacy methods `isCommitNeeded` and `recordCommit` are still supported and map to daily limits to preserve original behavior.

## Overriding State Path

Set `SDG_STATE_FILE` to change where state is stored (useful for testing or custom deployments):

```bash
export SDG_STATE_FILE=/var/lib/sure-daily-github/state.json
```

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
