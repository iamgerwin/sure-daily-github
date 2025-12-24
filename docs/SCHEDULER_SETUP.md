# Sure Daily GitHub - Scheduler Setup & Monitoring

## Current Setup Overview

The automated issue submission system is now configured with multiple layers of reliability:

### 1. Systemd Service
- **Service Name**: `sure-daily-github`
- **Status**: Running as systemd service
- **Location**: `/etc/systemd/system/sure-daily-github.service`
- **Features**:
  - Automatic restart on failure (restarts after 10 seconds)
  - Memory limit: 512MB
  - Runs as root user
  - Logs to: `/opt/sure-daily-github/logs/systemd.log`

### 2. Cron Scheduling (Internal)
- **Cron Expression**: `*/30 * * * *` (every 30 minutes)
- **Timezone**: Asia/Manila
- **Config File**: `/opt/sure-daily-github/config/config.yaml`
- **Runs**: Issue creation check every 30 minutes

### 3. Health Check Monitoring
- **Script**: `/opt/sure-daily-github/scripts/health-check.sh`
- **Frequency**: Every 30 minutes via crontab
- **Function**: 
  - Verifies systemd service is running
  - Auto-restarts service if stopped
  - Monitors for process hangs
  - Logs status to: `/opt/sure-daily-github/logs/health-check.log`

### 4. Daily Reset
- **Automatic**: Yes, the scheduler handles daily resets at midnight (Asia/Manila timezone)
- **Reset Logic**: 
  - When a new day starts (Asia/Manila timezone), the issue counter resets
  - Creates 1 issue per day for `manopo-web` repository (daily target: 5)
  - Randomized content for variety

## How to Check Status

### Quick Status Check
```bash
/opt/sure-daily-github/scripts/verify-status.sh
```

### Manual Service Commands
```bash
# Check service status
systemctl status sure-daily-github

# Restart service
systemctl restart sure-daily-github

# Stop service
systemctl stop sure-daily-github

# Start service
systemctl start sure-daily-github

# View live logs
journalctl -u sure-daily-github -f
```

### Check Logs
```bash
# View scheduler logs
tail -f /opt/sure-daily-github/logs/systemd.log

# View today's issues
tail -f /opt/sure-daily-github/logs/2025-12-24.log

# View health check logs
tail -f /opt/sure-daily-github/logs/health-check.log
```

## What to Expect

### Daily Behavior
1. **First Execution**: When the service starts, it runs immediately if needed
2. **Every 30 Minutes**: Scheduler checks if an issue should be created
3. **Once Per Day**: 
   - For `manopo-web`: Creates 1 new issue at random time
   - For other repos: Skipped (no daily target set)
4. **Midnight Reset**: At midnight Asia/Manila time, the daily counter resets

### Log Entry Examples
```
[2025-12-24T04:24:15.300Z] [INFO] Configuration loaded successfully {"repos":3,"schedule":true}
[2025-12-24T04:24:17.766Z] [INFO] Scheduler started {"cron":"*/30 * * * *","timezone":"Asia/Manila"}
[2025-12-24T04:30:01.500Z] [INFO] Scheduled task triggered
[2025-12-24T04:30:02.250Z] [INFO] Issue created {"repo":"iamgerwin/manopo-web","number":490,"title":"Automated Issue - ..."}
[2025-12-24T04:30:02.300Z] [INFO] Execution completed {"total":3,"successful":1,"skipped":2,"failed":0}
```

## Troubleshooting

### Service is not running
```bash
# Check status
systemctl status sure-daily-github

# Start it
systemctl start sure-daily-github

# Check logs for errors
journalctl -u sure-daily-github -n 50
```

### No issues being created
1. Check daily target configuration in `config.yaml`
2. Verify GitHub token in `.env` is valid
3. Check logs for authentication errors
4. Run manual execution: `npm run run`

### Service keeps restarting
- Check systemd error log: `/opt/sure-daily-github/logs/systemd-error.log`
- Check for memory issues: `systemctl status sure-daily-github`
- Verify Node.js is installed: `node --version`

### Memory usage is high
- The service has a 512MB limit set
- If memory usage exceeds this, it will be killed by systemd
- Check for memory leaks in logs
- Consider reducing the daily target or increasing memory limit

## Important Files

- **Main Scheduler**: `/opt/sure-daily-github/src/cli.js`
- **Configuration**: `/opt/sure-daily-github/config/config.yaml`
- **State File**: `/opt/sure-daily-github/data/issue-state.json`
- **Systemd Service**: `/etc/systemd/system/sure-daily-github.service`
- **Health Check Script**: `/opt/sure-daily-github/scripts/health-check.sh`
- **Status Script**: `/opt/sure-daily-github/scripts/verify-status.sh`

## Cron Jobs

### Current Cron Jobs
```bash
# Health check runs every 30 minutes
*/30 * * * * /opt/sure-daily-github/scripts/health-check.sh
```

To view/edit: `crontab -e`

## Recovery Steps

### Full Service Reset
```bash
# Stop service
systemctl stop sure-daily-github

# Reset state
cat > /opt/sure-daily-github/data/issue-state.json << 'RESET'
{
  "lastDailyReset": null,
  "repositories": {}
}
RESET

# Start service
systemctl start sure-daily-github
```

### Manual Issue Creation
```bash
# Run manually (for testing)
cd /opt/sure-daily-github && npm run run

# View status
npm run status
```

## Next Steps

- Monitor `/opt/sure-daily-github/logs/` directory for any issues
- Check the status script output daily
- GitHub contributions should appear automatically by 11:59 PM each day (Manila time)
