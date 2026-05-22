#!/usr/bin/env bash
# Browser Control — Screenshot Helper
# Takes a screenshot via the daemon, decodes base64 to a file,
# and prints only the file path — keeping base64 out of agent context.
set -euo pipefail

DAEMON_URL="http://127.0.0.1:10087"
OUTPUT_DIR="${BROWSER_CONTROL_SCREENSHOT_DIR:-/tmp/browser-control-screenshots}"
FORMAT="png"
QUALITY=""
SESSION=""
TAB_ID=""
FULL_PAGE="false"

usage() {
  cat <<'EOF'
Usage: screenshot.sh [OPTIONS]

Take a browser screenshot via the Browser Control Daemon.

Options:
  -o PATH      Output file path (default: /tmp/browser-control-screenshots/{timestamp}.{ext})
  -s SESSION   Browser session name
  -t TAB_ID    Specific tab ID to screenshot
  -f FORMAT    Image format: png or jpeg (default: png)
  -q QUALITY   JPEG quality 0-100 (jpeg only)
  -d URL       Daemon URL (default: http://127.0.0.1:10087)
  -p           Request full-page screenshot (current extension backend returns viewport capture with a note)
  -h           Show this help

Output:
  Prints the path to the saved screenshot file on stdout.
  All diagnostic messages go to stderr.
EOF
}

trace() { echo "[screenshot] $*" >&2; }

# ─── Parse args ───────────────────────────────────────────────────────

while getopts "o:s:t:f:q:d:ph" opt; do
  case "$opt" in
    o) OUTPUT_PATH="$OPTARG" ;;
    s) SESSION="$OPTARG" ;;
    t) TAB_ID="$OPTARG" ;;
    f) FORMAT="$OPTARG" ;;
    q) QUALITY="$OPTARG" ;;
    d) DAEMON_URL="$OPTARG" ;;
    p) FULL_PAGE="true" ;;
    h) usage; exit 0 ;;
    *) usage; exit 2 ;;
  esac
done

# Validate format
if [[ "$FORMAT" != "png" && "$FORMAT" != "jpeg" ]]; then
  trace "Error: format must be png or jpeg, got: $FORMAT"
  exit 2
fi

# ─── Check dependencies ───────────────────────────────────────────────

for dep in curl jq base64; do
  if ! command -v "$dep" >/dev/null 2>&1; then
    trace "Error: '$dep' is required but not found."
    exit 1
  fi
done

# ─── Build request ────────────────────────────────────────────────────

REQUEST_ARGS="{}"
REQUEST_ARGS=$(echo "$REQUEST_ARGS" | jq --arg fmt "$FORMAT" '. + {format: $fmt}')
if [[ -n "$TAB_ID" ]]; then
  REQUEST_ARGS=$(echo "$REQUEST_ARGS" | jq --arg tid "$TAB_ID" '. + {tabId: $tid}')
fi
if [[ "$FULL_PAGE" == "true" ]]; then
  REQUEST_ARGS=$(echo "$REQUEST_ARGS" | jq '. + {fullPage: true}')
fi
if [[ -n "$QUALITY" && "$FORMAT" == "jpeg" ]]; then
  REQUEST_ARGS=$(echo "$REQUEST_ARGS" | jq --argjson q "$QUALITY" '. + {quality: $q}')
fi

REQUEST_BODY=$(jq -n \
  --arg command "screenshot" \
  --argjson args "$REQUEST_ARGS" \
  --arg session "$SESSION" \
  '{command: $command, args: $args} + (if $session != "" then {session: $session} else {} end)')

trace "Requesting screenshot (format=$FORMAT, session=${SESSION:-default})..."

# ─── Call daemon ──────────────────────────────────────────────────────

BODY_FILE=$(mktemp)
HTTP_STATUS=$(curl -sS -w "%{http_code}" -o "$BODY_FILE" \
  -X POST "$DAEMON_URL/command" \
  -H 'Content-Type: application/json' \
  -d "$REQUEST_BODY" 2>&1) || {
  trace "Error: curl failed: $HTTP_STATUS"
  rm -f "$BODY_FILE"
  exit 1
}

RESPONSE_BODY=$(cat "$BODY_FILE")
rm -f "$BODY_FILE"

if [[ "$HTTP_STATUS" -ne 200 ]]; then
  ERROR_MSG=$(echo "$RESPONSE_BODY" | jq -r '.error // "Unknown error"' 2>/dev/null || echo "HTTP $HTTP_STATUS")
  trace "Error: daemon returned status $HTTP_STATUS: $ERROR_MSG"
  exit 1
fi

# ─── Determine output path ────────────────────────────────────────────

if [[ -z "${OUTPUT_PATH:-}" ]]; then
  mkdir -p "$OUTPUT_DIR"
  TIMESTAMP=$(date +%Y%m%d_%H%M%S)
  EXT="$FORMAT"
  [[ "$EXT" == "jpeg" ]] && EXT="jpg"
  OUTPUT_PATH="$OUTPUT_DIR/$TIMESTAMP.$EXT"
fi

# Ensure output directory exists
OUTPUT_DIR_PATH=$(dirname "$OUTPUT_PATH")
mkdir -p "$OUTPUT_DIR_PATH"

# ─── Extract artifact path or base64 data ─────────────────────────────

ARTIFACT_PATH=$(echo "$RESPONSE_BODY" | jq -er '.data.artifact.path // .artifacts[0].path // empty' 2>/dev/null || true)
if [[ -n "$ARTIFACT_PATH" && -f "$ARTIFACT_PATH" ]]; then
  if [[ "$ARTIFACT_PATH" != "$OUTPUT_PATH" ]]; then
    cp "$ARTIFACT_PATH" "$OUTPUT_PATH"
  fi
  FILE_SIZE=$(wc -c < "$OUTPUT_PATH" | tr -d ' ')
  trace "Screenshot saved: $OUTPUT_PATH"
  trace "  Source artifact: $ARTIFACT_PATH"
  trace "  File size: ${FILE_SIZE} bytes"
  echo "$OUTPUT_PATH"
  exit 0
fi

IMAGE_DATA=$(echo "$RESPONSE_BODY" | jq -er '.data.data | select(type == "string" and length > 0)' 2>/dev/null) || {
  # Try alternative response shapes
  IMAGE_DATA=$(echo "$RESPONSE_BODY" | jq -er '.data.image // .data.data // empty' 2>/dev/null) || {
    trace "Error: could not extract image data from response"
    trace "Response: $(echo "$RESPONSE_BODY" | head -c 500)"
    exit 1
  }
}

if [[ -z "$IMAGE_DATA" || "$IMAGE_DATA" == "null" ]]; then
  trace "Error: empty image data received"
  exit 1
fi

# ─── Decode and save ──────────────────────────────────────────────────

# Detect platform for base64 decode
if base64 --help 2>&1 | grep -q -- '-D'; then
  # macOS
  echo "$IMAGE_DATA" | base64 -D > "$OUTPUT_PATH"
else
  # Linux
  echo "$IMAGE_DATA" | base64 -d > "$OUTPUT_PATH"
fi

DATA_LENGTH=$(echo "$IMAGE_DATA" | wc -c | tr -d ' ')
FILE_SIZE=$(wc -c < "$OUTPUT_PATH" | tr -d ' ')

trace "Screenshot saved: $OUTPUT_PATH"
trace "  Data received: ${DATA_LENGTH} chars base64"
trace "  File size: ${FILE_SIZE} bytes"

# ─── Output: ONLY the file path ───────────────────────────────────────

echo "$OUTPUT_PATH"
