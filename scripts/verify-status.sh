#!/bin/bash

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

# Check recent logs
echo "3️⃣  Recent Activity:"
LATEST_LOG=$(ls -t /opt/sure-daily-github/logs/*.log 2>/dev/null | head -1)
if [ -n "$LATEST_LOG" ]; then
  echo "   Latest log: $(basename $LATEST_LOG)"
  echo "   Last 3 entries:"
  tail -3 "$LATEST_LOG" | sed 's/^/   /'
else
  echo "   ❌ No logs found"
fi
echo ""

# Check configuration
echo "4️⃣  Configuration:"
echo "   Cron Schedule: $(grep 'cron:' /opt/sure-daily-github/config/config.yaml | head -1 | sed 's/^[[:space:]]*/   /')"
echo "   Timezone: $(grep 'timezone:' /opt/sure-daily-github/config/config.yaml | head -1 | sed 's/^[[:space:]]*/   /')"
echo ""

# Check current state
echo "5️⃣  Current State:"
if [ -f /opt/sure-daily-github/data/issue-state.json ]; then
  echo "   Last reset: $(grep 'lastDailyReset' /opt/sure-daily-github/data/issue-state.json | sed 's/^[[:space:]]*//; s/[",]//g' | sed 's/lastDailyReset: //')"
else
  echo "   ❌ State file not found"
fi
echo ""

echo "=========================================="
