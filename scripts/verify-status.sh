#!/bin/bash

# Paths follow the install location of this script (scripts/ under the app
# root) and the same overrides the app itself honors, so a checkout outside
# /opt or a moved config or state file is still reported correctly
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_FILE="${CONFIG_PATH:-$APP_DIR/config/config.yaml}"
# Commit and simple issue mode count in state.json; advanced issue mode
# (range targets or intervalMinutes) keeps its own issue-state.json
COUNTER_STATE_FILE="${SDG_STATE_FILE:-$APP_DIR/data/state.json}"
ISSUE_STATE_FILE="${SDG_ISSUE_STATE_FILE:-$APP_DIR/data/issue-state.json}"
HEARTBEAT_FILE="${SDG_HEARTBEAT_FILE:-$APP_DIR/data/scheduler-heartbeat.json}"
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
# Only the file of the configured mode exists, so a missing one is not an
# error unless neither does
echo "5️⃣  Current State:"
if [ -f "$COUNTER_STATE_FILE" ]; then
  # lastCommitDate is a YYYY-MM-DD day, so the newest sorts last
  LAST_COMMIT=$(sed -n 's/.*"lastCommitDate"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$COUNTER_STATE_FILE" | sort | tail -1)
  echo "   Counter state: $COUNTER_STATE_FILE"
  echo "   Last commit: ${LAST_COMMIT:-none recorded}"
fi
if [ -f "$ISSUE_STATE_FILE" ]; then
  echo "   Issue state: $ISSUE_STATE_FILE"
  echo "   Last reset: $(grep 'lastDailyReset' "$ISSUE_STATE_FILE" | sed 's/^[[:space:]]*//; s/[",]//g' | sed 's/lastDailyReset: //')"
fi
if [ ! -f "$COUNTER_STATE_FILE" ] && [ ! -f "$ISSUE_STATE_FILE" ]; then
  echo "   ❌ State file not found: $COUNTER_STATE_FILE or $ISSUE_STATE_FILE"
fi
echo ""

# Check the scheduler heartbeat. The service can stay "active" while its cron
# ticks stop firing; the heartbeat's age (the same file mtime health-check.sh
# reads) shows whether the scheduler is still ticking.
echo "6️⃣  Scheduler Heartbeat:"
if [ -f "$HEARTBEAT_FILE" ]; then
  LAST_TICK=$(sed -n 's/.*"lastTickAt"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$HEARTBEAT_FILE")
  AGE_SECONDS=$(( $(date +%s) - $(stat -c %Y "$HEARTBEAT_FILE") ))
  [ "$AGE_SECONDS" -lt 0 ] && AGE_SECONDS=0
  echo "   Last tick: ${LAST_TICK:-unknown} ($(( AGE_SECONDS / 60 )) minutes ago)"
else
  echo "   ❌ No scheduler heartbeat at $HEARTBEAT_FILE (the scheduler writes it on start and on every tick)"
fi
echo ""

echo "=========================================="
