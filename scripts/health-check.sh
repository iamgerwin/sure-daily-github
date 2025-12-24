#!/bin/bash

# Health check script for sure-daily-github scheduler
SERVICE_NAME="sure-daily-github"
LOG_FILE="/opt/sure-daily-github/logs/health-check.log"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
}

# Check if service is running
if systemctl is-active --quiet $SERVICE_NAME; then
  log "✅ Service is running (PID: $(systemctl show -p MainPID --value $SERVICE_NAME))"
else
  log "⚠️  Service is not running. Attempting restart..."
  systemctl start $SERVICE_NAME
  sleep 2
  
  if systemctl is-active --quiet $SERVICE_NAME; then
    log "✅ Service restarted successfully"
  else
    log "❌ Failed to restart service"
    exit 1
  fi
fi

exit 0
