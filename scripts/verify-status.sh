#!/bin/bash

# Paths follow the install location of this script (scripts/ under the app
# root) and the same overrides the app itself honors, so a checkout outside
# /opt or a moved config or state file is still reported correctly
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_FILE="${CONFIG_PATH:-$APP_DIR/config/config.yaml}"
STATE_FILE="${SDG_ISSUE_STATE_FILE:-$APP_DIR/data/issue-state.json}"
LOG_DIR="$APP_DIR/logs"

echo "=========================================="
echo "  Sure Daily GitHub - Status Check"
echo "=========================================="
echo ""

# Check systemd service status
echo "1️⃣  Service Status:"
systemctl is-active sure-daily-github && echo "   ✅ Service is RUNNING" || echo "   ❌ Service is STOPPED"
echo "   PID: $(systemctl show -p MainPID --value sure-daily-github)"
echo ""

# Check process
echo "2️⃣  Process Check:"
if pgrep -f "node.*cli.js start" > /dev/null; then
  echo "   ✅ Node process found"
  ps aux | grep "node.*cli.js start" | grep -v grep | awk '{print "   PID:", $2, "| Memory:", $6"K", "| CPU:", $3"%"}'
else
  echo "   ❌ Node process NOT found"
fi
echo ""

# Check recent logs. Only the app's daily YYYY-MM-DD.log files count:
# health-check.log is rewritten every health check and would always be newest.
echo "3️⃣  Recent Activity:"
LATEST_LOG=$(ls -t "$LOG_DIR"/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9].log 2>/dev/null | head -1)
if [ -n "$LATEST_LOG" ]; then
  echo "   Latest log: $(basename "$LATEST_LOG")"
  echo "   Last 3 entries:"
  tail -3 "$LATEST_LOG" | sed 's/^/   /'
else
  echo "   ❌ No logs found in $LOG_DIR"
fi
echo ""

# Check configuration; anchored so commented-out keys are not reported
echo "4️⃣  Configuration:"
if [ -f "$CONFIG_FILE" ]; then
  echo "   Cron Schedule: $(grep -E '^[[:space:]]*cron:' "$CONFIG_FILE" | head -1 | sed 's/^[[:space:]]*/   /')"
  echo "   Timezone: $(grep -E '^[[:space:]]*timezone:' "$CONFIG_FILE" | head -1 | sed 's/^[[:space:]]*/   /')"
else
  echo "   ❌ Config file not found: $CONFIG_FILE"
fi
echo ""

# Check current state
echo "5️⃣  Current State:"
if [ -f "$STATE_FILE" ]; then
  echo "   Last reset: $(grep 'lastDailyReset' "$STATE_FILE" | sed 's/^[[:space:]]*//; s/[",]//g' | sed 's/lastDailyReset: //')"
else
  echo "   ❌ State file not found: $STATE_FILE"
fi
echo ""

echo "=========================================="
