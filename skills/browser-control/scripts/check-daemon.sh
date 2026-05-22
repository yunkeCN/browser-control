#!/usr/bin/env bash
# Browser Control — Daemon Status Check
# Quick check of daemon process status.
set -euo pipefail

PID_FILE="${HOME}/.browser-control"/"daemon.pid"
DAEMON_URL="http://127.0.0.1:10087"
JSON_OUTPUT=false

for arg in "$@"; do
  case "$arg" in
    --json) JSON_OUTPUT=true ;;
    -h|--help)
      echo "Usage: check-daemon.sh [--json]"
      echo "Check if the Browser Control daemon is running."
      exit 0
      ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

# Check by PID
PID=""
if [[ -f "$PID_FILE" ]]; then
  PID=$(cat "$PID_FILE")
fi

PID_RUNNING=false
if [[ -n "$PID" ]] && kill -0 "$PID" 2>/dev/null; then
  PID_RUNNING=true
fi

# Check by HTTP
HTTP_HEALTHY=false
HTTP_DATA="{}"
if HTTP_RESP=$(curl -s -o /dev/null -w "%{http_code}" "$DAEMON_URL/health" 2>/dev/null); then
  if [[ "$HTTP_RESP" == "200" ]]; then
    HTTP_HEALTHY=true
    HTTP_DATA=$(curl -s "$DAEMON_URL/health" 2>/dev/null || echo "{}")
  fi
fi

if [[ "$PID_RUNNING" == "true" || "$HTTP_HEALTHY" == "true" ]]; then
  RUNNING=true
else
  RUNNING=false
fi

if $JSON_OUTPUT; then
  jq -n \
    --argjson running "$RUNNING" \
    --argjson pidRunning "$PID_RUNNING" \
    --argjson httpHealthy "$HTTP_HEALTHY" \
    --arg pid "$PID" \
    '{running: $running, pid: $pid, pidRunning: $pidRunning, httpHealthy: $httpHealthy}'
else
  echo "Browser Control Daemon Check"
  echo "=========================="
  echo "Running: $([ "$RUNNING" == "true" ] && echo "YES" || echo "NO")"
  echo "PID: ${PID:-unknown}"
  echo "PID alive: $([ "$PID_RUNNING" == "true" ] && echo "yes" || echo "no")"
  echo "HTTP healthy: $([ "$HTTP_HEALTHY" == "true" ] && echo "yes" || echo "no")"

  if [[ "$RUNNING" != "true" ]]; then
    echo ""
    echo "Start the daemon with: browser-control start"
  fi
fi

if [[ "$RUNNING" == "true" ]]; then
  exit 0
else
  exit 1
fi
