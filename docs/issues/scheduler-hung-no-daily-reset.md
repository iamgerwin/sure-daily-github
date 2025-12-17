# Issue: Scheduler Process Hung - No Daily Reset or Issue Creation

**Date Occurred**: December 12-17, 2025  
**Date Resolved**: December 17, 2025  
**Severity**: High - Complete service outage

## Problem Summary

The GitHub issue automation system stopped creating issues after December 12, 2025 at 10:00 AM Manila time. Investigation revealed the scheduler process was still running but had stopped executing scheduled tasks, preventing the daily reset logic from running.

## Symptoms

1. No GitHub issues were being created despite scheduler running
2. No new log files created after `2025-12-12.log`
3. Process appeared healthy in `ps` output but was non-responsive
4. State file (`data/issue-state.json`) showed stale data:
   - Last daily reset: `2025-12-11T16:00:01.314Z`
   - Daily target reached (6/6) and never reset
   - All subsequent executions were skipped

## Root Causes

### 1. Long-Running Process Without Restart
- Process ID 2950 had been running for **24+ days** (since November 23)
- Node.js process likely experienced memory leaks or event loop issues
- No process monitoring or automatic restart mechanism in place

### 2. No Daily Reset Mechanism When Scheduler Hangs
- Daily reset logic is embedded in the scheduled execution flow
- When scheduler stops triggering, reset never occurs
- State persists indefinitely, causing all repos to report "daily target reached"

### 3. Lack of Health Monitoring
- No alerting when logs stop being generated
- No process health checks or heartbeat monitoring
- No automatic recovery mechanism

## Investigation Steps

```bash
# 1. Check process status
ps aux | grep "node.*cli.js start"
# Found: PID 2950 running since Nov 23

# 2. Check recent logs
ls -lth logs/ | head -10
# Last log: 2025-12-12.log (9.1K)

# 3. Check log contents
tail -50 logs/2025-12-12.log
# All executions showed: "successful":0, "skipped":3

# 4. Check state file
cat data/issue-state.json
# Showed: lastDailyReset: "2025-12-11T16:00:01.314Z"
# issuesCreatedToday: 6, todayTarget: 6

# 5. Manual test run
node src/cli.js run
# SUCCESS - Daily reset triggered, new issue created
```

## Resolution Steps

### Immediate Fix

```bash
# 1. Stop the hung process
kill 2950

# 2. Verify process stopped
ps aux | grep "node.*cli.js"

# 3. Restart scheduler in background
cd /opt/sure-daily-github
nohup node src/cli.js start > /dev/null 2>&1 &

# 4. Verify new process started
ps aux | grep "node src/cli.js start"
tail -f logs/$(date +%Y-%m-%d).log
```

### Verification

```bash
# Check status
node src/cli.js status

# Verify issue was created
curl -H "Authorization: token $GITHUB_TOKEN" \
  https://api.github.com/repos/iamgerwin/manopo-web/issues/467

# Monitor for next scheduled run (30 minutes)
tail -f logs/$(date +%Y-%m-%d).log
```

## Long-Term Recommendations

### 1. Process Management with PM2

Install and configure PM2 for automatic restarts:

```bash
# Install PM2 globally
npm install -g pm2

# Start with PM2
pm2 start src/cli.js --name sure-daily-github -- start

# Configure auto-restart on crashes
pm2 startup
pm2 save

# Monitor
pm2 monit
pm2 logs sure-daily-github
```

**PM2 Configuration** (`ecosystem.config.cjs`):
```javascript
module.exports = {
  apps: [{
    name: 'sure-daily-github',
    script: './src/cli.js',
    args: 'start',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '200M',
    env: {
      NODE_ENV: 'production',
      LOG_LEVEL: 'info'
    },
    error_file: './logs/pm2-error.log',
    out_file: './logs/pm2-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z'
  }]
};
```

### 2. Systemd Service (Alternative)

Create `/etc/systemd/system/sure-daily-github.service`:

```ini
[Unit]
Description=Sure Daily GitHub Issue Automation
After=network.target

[Service]
Type=simple
User=gerwin
WorkingDirectory=/opt/sure-daily-github
ExecStart=/usr/bin/node /opt/sure-daily-github/src/cli.js start
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

Enable and start:
```bash
sudo systemctl daemon-reload
sudo systemctl enable sure-daily-github
sudo systemctl start sure-daily-github
sudo systemctl status sure-daily-github
```

### 3. Health Check Endpoint

Add a simple health check to the scheduler:

```javascript
// src/utils/health-check.js
import fs from 'fs';
import path from 'path';

class HealthCheck {
  constructor() {
    this.healthFile = path.join(__dirname, '../../.state/health.json');
  }
  
  updateHeartbeat() {
    const health = {
      lastHeartbeat: new Date().toISOString(),
      pid: process.pid,
      uptime: process.uptime()
    };
    fs.writeFileSync(this.healthFile, JSON.stringify(health, null, 2));
  }
  
  startHeartbeat(intervalMs = 60000) {
    this.updateHeartbeat();
    this.interval = setInterval(() => this.updateHeartbeat(), intervalMs);
  }
  
  stopHeartbeat() {
    if (this.interval) {
      clearInterval(this.interval);
    }
  }
}

export default new HealthCheck();
```

### 4. Monitoring Script

Create a monitoring script to alert on stale logs:

```bash
#!/bin/bash
# scripts/check-health.sh

LOG_DIR="/opt/sure-daily-github/logs"
HEALTH_FILE="/opt/sure-daily-github/.state/health.json"
MAX_AGE_MINUTES=60

# Check if today's log exists and is recent
TODAY_LOG="$LOG_DIR/$(date +%Y-%m-%d).log"
if [ ! -f "$TODAY_LOG" ]; then
  echo "ERROR: Today's log file missing"
  exit 1
fi

# Check log age
LOG_AGE=$(( $(date +%s) - $(stat -c %Y "$TODAY_LOG") ))
if [ $LOG_AGE -gt $(( MAX_AGE_MINUTES * 60 )) ]; then
  echo "ERROR: Log file is stale (${LOG_AGE}s old)"
  exit 1
fi

# Check health heartbeat
if [ -f "$HEALTH_FILE" ]; then
  HEARTBEAT=$(jq -r .lastHeartbeat "$HEALTH_FILE")
  HEARTBEAT_AGE=$(( $(date +%s) - $(date -d "$HEARTBEAT" +%s) ))
  if [ $HEARTBEAT_AGE -gt $(( MAX_AGE_MINUTES * 60 )) ]; then
    echo "ERROR: Heartbeat is stale (${HEARTBEAT_AGE}s old)"
    exit 1
  fi
fi

echo "OK: System healthy"
exit 0
```

Add to crontab:
```bash
# Check health every 15 minutes
*/15 * * * * /opt/sure-daily-github/scripts/check-health.sh || systemctl restart sure-daily-github
```

### 5. State Recovery Mechanism

Add automatic state reset if daily reset is missed:

```javascript
// In advanced-issue-handler.js, enhance shouldResetDaily()
shouldResetDaily(state, timezone) {
  if (!state.lastDailyReset) return true;
  
  const lastReset = new Date(state.lastDailyReset);
  const now = new Date();
  const lastResetDate = this.getDateInTimezone(lastReset, timezone);
  const nowDate = this.getDateInTimezone(now, timezone);
  
  // Force reset if more than 24 hours have passed
  const hoursSinceReset = (now - lastReset) / (1000 * 60 * 60);
  if (hoursSinceReset > 24) {
    logger.warn('Forcing daily reset - more than 24 hours since last reset', {
      lastReset: state.lastDailyReset,
      hoursSinceReset: Math.round(hoursSinceReset)
    });
    return true;
  }
  
  return nowDate !== lastResetDate;
}
```

## Prevention Checklist

- [ ] Implement process manager (PM2 or systemd)
- [ ] Add health check heartbeat mechanism
- [ ] Create monitoring/alerting script
- [ ] Set up automatic restart on failure
- [ ] Add forced reset after 24 hours threshold
- [ ] Document restart procedures in runbook
- [ ] Set up log rotation to prevent disk space issues
- [ ] Add memory limits and automatic restarts on high memory usage

## Related Files

- `src/core/scheduler.js` - Scheduler implementation
- `src/github/advanced-issue-handler.js` - Daily reset logic
- `src/utils/logger.js` - Logging implementation
- `data/issue-state.json` - State persistence
- `logs/*.log` - Daily execution logs

## References

- Process uptime at failure: 24 days, 12 hours
- Last successful execution: 2025-12-12 10:00:00 Manila Time
- Resolution execution: 2025-12-17 17:20:48 UTC
- GitHub Issue created after fix: #467 in iamgerwin/manopo-web
