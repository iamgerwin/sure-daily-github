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
HEARTBEAT_FILE="${SDG_HEARTBEAT_FILE:-$APP_DIR/data/scheduler-heartbeat.json}"
HEARTBEAT_MAX_AGE_MINUTES="${HEARTBEAT_MAX_AGE_MINUTES:-0}"

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
      log "⚠️  Scheduler heartbeat is $(( AGE_SECONDS / 60 )) minutes old (limit ${HEARTBEAT_MAX_AGE_MINUTES}). Restarting hung service..."
      restart_service
    fi
  fi
fi

exit 0
