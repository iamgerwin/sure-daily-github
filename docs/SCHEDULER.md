# Scheduler Configuration Guide

The Sure Daily GitHub tool supports flexible scheduling using cron expressions with timezone support.

## Quick Start

Enable the scheduler in your `config/config.yaml`:

```yaml
schedule:
  enabled: true
  cron: "*/3 * * * *"    # Your desired interval
  timezone: "Asia/Manila" # Your timezone
```

## Common Interval Patterns

### Minutes

| Cron Expression | Description | Use Case |
|-----------------|-------------|----------|
| `*/3 * * * *` | Every 3 minutes | Testing, high-frequency updates |
| `*/5 * * * *` | Every 5 minutes | Development testing |
| `*/15 * * * *` | Every 15 minutes | Frequent updates |
| `*/30 * * * *` | Every 30 minutes | Regular updates |

### Hours

| Cron Expression | Description | Use Case |
|-----------------|-------------|----------|
| `0 * * * *` | Every hour (on the hour) | Hourly updates |
| `0 */2 * * *` | Every 2 hours | Regular activity |
| `0 */6 * * *` | Every 6 hours (default) | Balanced frequency |
| `0 */12 * * *` | Every 12 hours | Twice daily |

### Daily

| Cron Expression | Description | Use Case |
|-----------------|-------------|----------|
| `0 9 * * *` | Daily at 9 AM | Morning updates |
| `0 17 * * *` | Daily at 5 PM | Evening updates |
| `0 9,17 * * *` | Twice daily (9 AM & 5 PM) | Morning and evening |
| `0 0 * * *` | Daily at midnight | End of day updates |

### Weekly

| Cron Expression | Description | Use Case |
|-----------------|-------------|----------|
| `0 9 * * 1-5` | Weekdays at 9 AM | Business hours only |
| `0 9 * * 1` | Every Monday at 9 AM | Weekly updates |
| `0 9 * * 6,0` | Weekends at 9 AM | Weekend activity |

## Timezone Configuration

### Supported Timezones

The scheduler supports all IANA timezone names:

```yaml
schedule:
  timezone: "Asia/Manila"        # Philippines
  # timezone: "America/New_York" # US Eastern
  # timezone: "Europe/London"    # UK
  # timezone: "Asia/Tokyo"       # Japan
  # timezone: "UTC"              # Universal Time
```

### Common Timezones

- **Asia**: `Asia/Manila`, `Asia/Tokyo`, `Asia/Singapore`, `Asia/Shanghai`
- **Americas**: `America/New_York`, `America/Los_Angeles`, `America/Chicago`
- **Europe**: `Europe/London`, `Europe/Paris`, `Europe/Berlin`
- **Pacific**: `Pacific/Auckland`, `Australia/Sydney`

## Configuration Examples

### Example 1: Every 3 Minutes (Testing)

```yaml
general:
  dailyTarget: 5

schedule:
  enabled: true
  cron: "*/3 * * * *"
  timezone: "Asia/Manila"
```

### Example 2: Every 6 Hours (Production)

```yaml
general:
  dailyTarget: 4

schedule:
  enabled: true
  cron: "0 */6 * * *"  # 12 AM, 6 AM, 12 PM, 6 PM
  timezone: "Asia/Manila"
```

### Example 3: Weekdays Only (9 AM & 5 PM)

```yaml
general:
  dailyTarget: 2

schedule:
  enabled: true
  cron: "0 9,17 * * 1-5"  # Mon-Fri at 9 AM and 5 PM
  timezone: "Asia/Manila"
```

### Example 4: Once Daily (Morning)

```yaml
general:
  dailyTarget: 1

schedule:
  enabled: true
  cron: "0 9 * * *"  # 9 AM daily
  timezone: "Asia/Manila"
```

## Cron Syntax Reference

```
 ┌────────────── minute (0 - 59)
 │ ┌──────────── hour (0 - 23)
 │ │ ┌────────── day of month (1 - 31)
 │ │ │ ┌──────── month (1 - 12)
 │ │ │ │ ┌────── day of week (0 - 6) (Sunday = 0)
 │ │ │ │ │
 * * * * *
```

### Special Characters

- `*` - Any value (every minute, hour, etc.)
- `*/n` - Every n units (*/5 = every 5 minutes)
- `n,m` - Specific values (9,17 = 9 AM and 5 PM)
- `n-m` - Range of values (1-5 = Monday to Friday)

## Running the Scheduler

### Start Scheduler

```bash
# Start in foreground (see output)
node src/cli.js start

# Or with PM2 (background)
pm2 start src/cli.js --name "sure-daily-github" -- start

# Or with systemd (production)
sudo systemctl start sure-daily-github
```

### Stop Scheduler

```bash
# If running in foreground
Ctrl+C

# If using PM2
pm2 stop sure-daily-github

# If using systemd
sudo systemctl stop sure-daily-github
```

### Monitor Scheduler

```bash
# View logs in real-time
tail -f logs/*.log

# With PM2
pm2 logs sure-daily-github

# With systemd
sudo journalctl -u sure-daily-github -f
```

## Testing the Scheduler

### 1. Quick Test (3 Minutes)

```yaml
schedule:
  enabled: true
  cron: "*/3 * * * *"
  timezone: "Asia/Manila"
```

```bash
# Start and watch
node src/cli.js start

# In another terminal, monitor
tail -f logs/*.log
```

### 2. Dry Run Test

```yaml
general:
  dryRun: true  # No actual commits/issues

schedule:
  enabled: true
  cron: "*/3 * * * *"
```

### 3. Check Status

```bash
node src/cli.js status
```

## Troubleshooting

### Scheduler Not Running

1. **Check configuration:**
   ```bash
   node src/cli.js validate
   ```

2. **Verify cron expression:**
   - Visit https://crontab.guru to validate your cron
   - Ensure timezone is correct

3. **Check logs:**
   ```bash
   tail -20 logs/*.log
   ```

### No Issues/Commits Created

1. **Check daily target:**
   - Ensure `dailyTarget` is not already met
   - View current state: `cat data/state.json`

2. **Verify repository config:**
   - Each repo can have its own `dailyTarget`
   - Check if repo is `enabled: true`

3. **Test manually:**
   ```bash
   node src/cli.js run --dry-run
   ```

### Timezone Issues

1. **List available timezones:**
   ```bash
   ls /usr/share/zoneinfo/
   ```

2. **Test timezone:**
   ```bash
   TZ=Asia/Manila date
   ```

3. **Verify in logs:**
   - Scheduler logs show timezone on startup
   - Check: `[INFO] Scheduler started {"timezone":"Asia/Manila"}`

## Best Practices

### VPS Deployment

1. **Production Intervals:**
   - Use `0 */6 * * *` or longer for production
   - Avoid intervals < 1 hour on VPS

2. **Resource Management:**
   - Longer intervals = less API calls
   - Prevents hitting GitHub rate limits
   - Reduces VPS load

3. **Monitoring:**
   - Set up log rotation
   - Monitor disk space
   - Check state file periodically

### Development

1. **Testing:**
   - Use `*/3 * * * *` for quick testing
   - Enable `dryRun: true` first
   - Increase `dailyTarget` for multiple runs

2. **Debugging:**
   - Run in foreground to see output
   - Use `LOG_LEVEL=debug` for detailed logs
   - Check state file after each run

## Rate Limits

### GitHub API Limits

- **Authenticated**: 5,000 requests/hour
- **Per repo**: ~10 requests per execution
- **Safe intervals**:
  - Every 15 min = ~40 repos max
  - Every hour = ~166 repos max
  - Every 6 hours = ~1,000 repos max

### Recommendations

- **1-5 repos**: Any interval works
- **5-20 repos**: Use hourly or longer
- **20+ repos**: Use 6-hour intervals or daily

## Examples in Production

### Small Project (1-2 repos)

```yaml
schedule:
  enabled: true
  cron: "0 */6 * * *"    # Every 6 hours
  timezone: "Asia/Manila"
```

### Medium Project (5-10 repos)

```yaml
schedule:
  enabled: true
  cron: "0 9,17 * * 1-5" # Weekdays, twice daily
  timezone: "Asia/Manila"
```

### Large Project (20+ repos)

```yaml
schedule:
  enabled: true
  cron: "0 9 * * *"      # Once daily at 9 AM
  timezone: "Asia/Manila"
```

## See Also

- [Deployment Guide](../deployment/DEPLOYMENT.md)
- [Configuration Reference](../README.md#configuration-reference)
- [Cron Expression Tester](https://crontab.guru)
