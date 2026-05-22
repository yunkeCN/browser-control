#!/usr/bin/env bash
# Browser Control — Session Cleanup
# Closes sessions (and their tabs) that have been idle for too long.
set -euo pipefail

DAEMON_URL="${BROWSER_CONTROL_DAEMON_URL:-http://127.0.0.1:10087}"
MAX_IDLE_MINUTES="${BROWSER_CONTROL_MAX_IDLE:-30}"
DRY_RUN=false

usage() {
  cat <<'EOF'
Usage: session-cleanup.sh [OPTIONS]

Close idle browser sessions and their tabs.

Options:
  --dry-run        List idle sessions without closing them
  --max-idle N     Maximum idle time in minutes (default: 30)
  -d URL           Daemon URL (default: http://127.0.0.1:10087)
  -h               Show this help
EOF
}

while getopts "d:n:-:h" opt; do
  case "$opt" in
    d) DAEMON_URL="$OPTARG" ;;
    n) MAX_IDLE_MINUTES="$OPTARG" ;;
    -)
      case "${OPTARG}" in
        dry-run) DRY_RUN=true ;;
        max-idle) MAX_IDLE_MINUTES="${!OPTIND}"; OPTIND=$((OPTIND + 1)) ;;
        *) echo "Unknown option: --${OPTARG}" >&2; exit 2 ;;
      esac
      ;;
    h) usage; exit 0 ;;
    *) usage; exit 2 ;;
  esac
done

# ─── Get sessions from daemon ─────────────────────────────────────────

STATUS=$(curl -s "$DAEMON_URL/status" 2>/dev/null) || {
  echo "Error: Cannot reach daemon at $DAEMON_URL" >&2
  exit 1
}

SESSION_COUNT=$(echo "$STATUS" | jq '.sessions | length // 0')
if [[ "$SESSION_COUNT" -eq 0 ]]; then
  echo "No active sessions."
  exit 0
fi

NOW=$(date +%s)
CLOSED=0

echo "Checking sessions (max idle: ${MAX_IDLE_MINUTES}min)..."
echo ""

echo "$STATUS" | jq -c '.sessions[]' | while read -r session; do
  NAME=$(echo "$session" | jq -r '.name')
  LAST_ACTIVITY=$(echo "$session" | jq -r '.lastActivity')
  TAB_COUNT=$(echo "$session" | jq -r '.tabCount // 0')

  # Calculate idle time
  if [[ "$LAST_ACTIVITY" != "null" && -n "$LAST_ACTIVITY" ]]; then
    LAST_EPOCH=$(date -j -f "%Y-%m-%dT%H:%M:%S" "${LAST_ACTIVITY%.*}" +%s 2>/dev/null || echo 0)
    IDLE_SEC=$((NOW - LAST_EPOCH))
    IDLE_MIN=$((IDLE_SEC / 60))
  else
    IDLE_MIN=0
  fi

  if [[ "$IDLE_MIN" -ge "$MAX_IDLE_MINUTES" ]]; then
    if $DRY_RUN; then
      echo "[DRY RUN] Would close: $NAME (idle: ${IDLE_MIN}min, tabs: $TAB_COUNT)"
    else
      echo "Closing session: $NAME (idle: ${IDLE_MIN}min, tabs: $TAB_COUNT)"
      curl -s -X POST "$DAEMON_URL/command" \
        -H 'Content-Type: application/json' \
        -d "{\"action\":\"close_session\",\"session\":\"$NAME\"}" > /dev/null
      echo "  Closed."
    fi
  else
    echo "Session '$NAME': active (idle: ${IDLE_MIN}min, tabs: $TAB_COUNT)"
  fi
done

if $DRY_RUN; then
  echo ""
  echo "Dry run complete. Use without --dry-run to actually close sessions."
else
  echo ""
  echo "Cleanup complete."
fi
