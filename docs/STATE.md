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
  - Legacy fields `lastCommitDate`, `commitsToday`, `totalCommits` are maintained.

## Timezone

All windows respect `general.timezone` from your configuration (default: `UTC`). This impacts boundary resets for hourly/daily/weekly periods.

## Limits

Limits are evaluated before each action:

- When `randomization.timeVariations.enabled: true`, the `max` values for `hourly`, `daily`, and `weekly` are treated as hard caps.
- Otherwise, the repository `dailyTarget` (number or range) determines the daily cap.

## Graceful Fallbacks

- If the state file is missing or corrupted, the system starts fresh and keeps a `.bak` backup (when possible).
- The directory structure is created on demand; failures are logged without crashing the process.

## Overriding State Path

Set `SDG_STATE_FILE` to change where state is stored (useful for testing or custom deployments):

```bash
export SDG_STATE_FILE=/var/lib/sure-daily-github/state.json
```

## Testing

Run unit tests covering state logic and window resets:

```bash
npm test
```

