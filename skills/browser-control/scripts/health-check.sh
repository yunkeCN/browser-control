#!/usr/bin/env bash
# Browser Control — Health Check Script
# Checks daemon status + extension connectivity.
# Exit codes: 0 = all healthy, 1 = daemon issue, 2 = extension not connected, 3 = not running
set -euo pipefail

DAEMON_URL="${BROWSER_CONTROL_DAEMON_URL:-http://127.0.0.1:10087}"

usage() {
  cat <<'EOF'
Usage: health-check.sh [--json]

Check the health of the Browser Control system.

Options:
  --json    Output results as JSON
  -h        Show this help

Exit codes:
  0  All systems healthy
  1  Daemon not running or unhealthy
  2  Extension not connected
  3  Unknown error
EOF
}

json_output=false

for arg in "$@"; do
  case "$arg" in
    --json) json_output=true ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; usage; exit 3 ;;
  esac
done

# ─── Check daemon ─────────────────────────────────────────────────────

HEALTH_RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" "$DAEMON_URL/health" 2>/dev/null || echo "000")

if [[ "$HEALTH_RESPONSE" == "000" ]]; then
  if $json_output; then
    echo '{"running":false,"port":10087,"error":"Daemon not reachable"}'
  else
    echo "Browser Control Health Check"
    echo "=================================="
    echo "Daemon: NOT RUNNING"
    echo "URL: $DAEMON_URL"
    echo ""
    echo "Start the daemon with: browser-control start"
  fi
  exit 1
fi

if [[ "$HEALTH_RESPONSE" != "200" ]]; then
  if $json_output; then
    echo "{\"running\":true,\"healthy\":false,\"httpStatus\":$HEALTH_RESPONSE}"
  else
    echo "Daemon returned HTTP $HEALTH_RESPONSE"
  fi
  exit 1
fi

# ─── Parse health response ────────────────────────────────────────────

HEALTH_DATA=$(curl -s "$DAEMON_URL/health")
RUNNING=$(echo "$HEALTH_DATA" | jq -r '.running // false')
EXT_CONNECTED=$(echo "$HEALTH_DATA" | jq -r '.extensionConnected // false')
UPTIME=$(echo "$HEALTH_DATA" | jq -r '.uptimeSeconds // 0')
VERSION=$(echo "$HEALTH_DATA" | jq -r '.version // "unknown"')

if $json_output; then
  echo "$HEALTH_DATA"
else
  echo "Browser Control Health Check"
  echo "=================================="
  echo "Daemon: RUNNING"
  echo "Version: $VERSION"
  echo "Port: 10087"
  echo "Uptime: ${UPTIME}s"
  echo "Extension: $([ "$EXT_CONNECTED" == "true" ] && echo "CONNECTED" || echo "DISCONNECTED")"
  echo ""
  if [[ "$EXT_CONNECTED" != "true" ]]; then
    echo "The Chrome Extension is not connected."
    echo "Ensure Chrome is running and the Browser Control extension is installed and enabled."
  else
    echo "All systems healthy."
  fi
fi

if [[ "$RUNNING" != "true" ]]; then
  exit 1
fi

if [[ "$EXT_CONNECTED" != "true" ]]; then
  exit 2
fi

exit 0
