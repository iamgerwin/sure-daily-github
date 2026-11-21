#!/bin/bash

# Paths follow the install location of this script (scripts/ under the app
# root) and the same overrides the app itself honors, so a checkout outside
# /opt or a moved config or state file is still reported correctly
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$APP_DIR/logs"

# The value of $1 in the app's .env, read the way the service's dotenv reads it
# (optional `export`, quotes stripped, unquoted `#` comments and surrounding
# whitespace dropped, last line wins). Fails when the file or key is missing.
# Same parser as health-check.sh.
dotenv_value() {
  local key="$1" file="$APP_DIR/.env" line value="" found=1
  local assign="^[[:space:]]*(export[[:space:]]+)?${key}[[:space:]]*=[[:space:]]*(.*)$"
  local double_quoted='^"([^"]*)"' single_quoted="^'([^']*)'"
  [ -r "$file" ] || return 1
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    [[ "$line" =~ $assign ]] || continue
    value="${BASH_REMATCH[2]}"
    if [[ "$value" =~ $double_quoted ]] || [[ "$value" =~ $single_quoted ]]; then
      value="${BASH_REMATCH[1]}"
    else
      value="${value%%#*}"
      value="${value%"${value##*[![:space:]]}"}"
    fi
    found=0
  done < "$file"
  [ "$found" -eq 0 ] && printf '%s' "$value"
  return "$found"
}

# The path the service uses for override $1 (default $2). The service gets
# overrides from .env through dotenv, but this script is run from a plain
# shell: a file moved only in .env would be reported as missing, or the
# default file shown in its place. A variable set in the environment still
# wins, as it does for dotenv. A relative path is resolved against the app
# directory, the service's working directory.
app_path() {
  local key="$1" default="$2" value
  if [ -n "${!key+set}" ]; then
    value="${!key}"
  else
    value="$(dotenv_value "$key")"
  fi
  value="${value:-$default}"
  case "$value" in
    /*) printf '%s' "$value" ;;
    *) printf '%s' "$APP_DIR/$value" ;;
  esac
}

CONFIG_FILE="$(app_path CONFIG_PATH "$APP_DIR/config/config.yaml")"
STATE_FILE="$(app_path SDG_ISSUE_STATE_FILE "$APP_DIR/data/issue-state.json")"
HEARTBEAT_FILE="$(app_path SDG_HEARTBEAT_FILE "$APP_DIR/data/scheduler-heartbeat.json")"

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
