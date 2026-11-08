#!/bin/bash

# Health check script for sure-daily-github scheduler
#
# Restarts the service when it is stopped. With HEARTBEAT_MAX_AGE_MINUTES set,
# it also restarts a service that is running but whose cron ticks stopped
# firing: the scheduler rewrites data/scheduler-heartbeat.json on start and on
# every tick, so a file older than that limit means a hung process. Set the
# limit above the cron interval (e.g. 90 for a */30 schedule).
SERVICE_NAME="sure-daily-github"
APP_DIR="${SDG_APP_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
LOG_FILE="$APP_DIR/logs/health-check.log"

# The value of $1 in the app's .env, read the way the service's dotenv reads it
# (optional `export`, quotes stripped, unquoted `#` comments and surrounding
# whitespace dropped, last line wins). Fails when the file or key is missing.
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

# The service loads .env through dotenv, but cron runs this script without it:
# a heartbeat moved only in .env would never be found here, and the hang check
# would be skipped forever. A variable set in the environment still wins, as it
# does for dotenv. A relative path is resolved against the app directory, the
# service's working directory.
if [ -z "${SDG_HEARTBEAT_FILE+set}" ]; then
  SDG_HEARTBEAT_FILE="$(dotenv_value SDG_HEARTBEAT_FILE)"
fi
HEARTBEAT_FILE="${SDG_HEARTBEAT_FILE:-$APP_DIR/data/scheduler-heartbeat.json}"
case "$HEARTBEAT_FILE" in
  /*) ;;
  *) HEARTBEAT_FILE="$APP_DIR/$HEARTBEAT_FILE" ;;
esac
HEARTBEAT_MAX_AGE_MINUTES="${HEARTBEAT_MAX_AGE_MINUTES:-0}"
# Touched on every hang restart; a heartbeat not newer than it means the
# restarted scheduler never wrote one, so another restart would not help
HANG_RESTART_MARKER="$APP_DIR/logs/health-check-hang-restart"

mkdir -p "$(dirname "$LOG_FILE")"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
}

restart_service() {
  systemctl restart "$SERVICE_NAME"
  sleep 2

  if systemctl is-active --quiet "$SERVICE_NAME"; then
    log "✅ Service restarted successfully"
  else
    log "❌ Failed to restart service"
    exit 1
  fi
}

if ! [[ "$HEARTBEAT_MAX_AGE_MINUTES" =~ ^[0-9]+$ ]]; then
  log "⚠️  Ignoring HEARTBEAT_MAX_AGE_MINUTES=$HEARTBEAT_MAX_AGE_MINUTES (expected whole minutes)"
  HEARTBEAT_MAX_AGE_MINUTES=0
fi
# Force base 10: bash arithmetic reads a leading zero (e.g. 090) as octal
HEARTBEAT_MAX_AGE_MINUTES=$(( 10#$HEARTBEAT_MAX_AGE_MINUTES ))

# Check if service is running
if ! systemctl is-active --quiet "$SERVICE_NAME"; then
  log "⚠️  Service is not running. Attempting restart..."
  restart_service
  exit 0
fi

log "✅ Service is running (PID: $(systemctl show -p MainPID --value "$SERVICE_NAME"))"

# Check that the scheduler is still ticking
if [ "$HEARTBEAT_MAX_AGE_MINUTES" -gt 0 ]; then
  if [ ! -f "$HEARTBEAT_FILE" ]; then
    log "⚠️  No scheduler heartbeat at $HEARTBEAT_FILE yet; skipping the hang check"
  else
    AGE_SECONDS=$(( $(date +%s) - $(stat -c %Y "$HEARTBEAT_FILE") ))
    if [ "$AGE_SECONDS" -gt $(( HEARTBEAT_MAX_AGE_MINUTES * 60 )) ]; then
      HEARTBEAT_INFO="owner $(stat -c %U "$HEARTBEAT_FILE"), directory owner $(stat -c %U "$(dirname "$HEARTBEAT_FILE")")"
      if [ -f "$HANG_RESTART_MARKER" ] && ! [ "$HEARTBEAT_FILE" -nt "$HANG_RESTART_MARKER" ]; then
        log "❌ Scheduler heartbeat is $(( AGE_SECONDS / 60 )) minutes old and was not refreshed after the hang restart at $(date -d "@$(stat -c %Y "$HANG_RESTART_MARKER")" '+%Y-%m-%d %H:%M:%S'). Not restarting again: check that the service can write $HEARTBEAT_FILE ($HEARTBEAT_INFO) and that it uses the same SDG_HEARTBEAT_FILE"
      else
        log "⚠️  Scheduler heartbeat is $(( AGE_SECONDS / 60 )) minutes old (limit ${HEARTBEAT_MAX_AGE_MINUTES}, $HEARTBEAT_INFO). Restarting hung service..."
        touch "$HANG_RESTART_MARKER"
        restart_service
      fi
    fi
  fi
fi

exit 0
