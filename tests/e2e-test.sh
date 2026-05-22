#!/usr/bin/env bash
# Browser Control — Live Chrome Extension End-to-End Test
# Tests the complete stack: daemon → extension → browser operations.
set -euo pipefail

PASS=0
FAIL=0
SKIP=0
DAEMON_URL="${BROWSER_CONTROL_DAEMON_URL:-http://127.0.0.1:10087}"
SESSION="test-$(date +%s)"
if [[ -n "${BROWSER_CONTROL_FIXTURE_PORT:-}" ]]; then
  FIXTURE_PORT="$BROWSER_CONTROL_FIXTURE_PORT"
else
  FIXTURE_PORT="$(python3 - <<'PY'
import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
PY
)"
fi
FIXTURE_URL="http://127.0.0.1:${FIXTURE_PORT}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXTENSION_PATH="${REPO_ROOT}/skills/browser-control/extension"
TMP_DIR="$(mktemp -d)"
FIXTURE_PID=""

green() { echo -e "\033[0;32m$*\033[0m"; }
red() { echo -e "\033[0;31m$*\033[0m"; }
yellow() { echo -e "\033[0;33m$*\033[0m"; }
info() { echo "[TEST] $*"; }

cleanup() {
  if [[ -n "$FIXTURE_PID" ]]; then
    kill "$FIXTURE_PID" >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

check() {
  local desc="$1"
  local expected="$2"
  local actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    green "  PASS: $desc"
    PASS=$((PASS + 1))
  else
    red "  FAIL: $desc (expected: $expected, got: $actual)"
    FAIL=$((FAIL + 1))
  fi
}

check_true() {
  local desc="$1"
  local actual="$2"
  if [[ "$actual" == "true" ]]; then
    green "  PASS: $desc"
    PASS=$((PASS + 1))
  else
    red "  FAIL: $desc"
    FAIL=$((FAIL + 1))
  fi
}

skip() {
  yellow "  SKIP: $*"
  SKIP=$((SKIP + 1))
}

api_call() {
  local action="$1"
  local args_json="${2:-}"
  if [[ -z "$args_json" ]]; then
    args_json='{}'
  fi
  curl -s -X POST "$DAEMON_URL/command" \
    -H 'Content-Type: application/json' \
    -d "{\"action\":\"$action\",\"args\":$args_json,\"session\":\"$SESSION\"}"
}

write_fixture() {
  cat > "$TMP_DIR/index.html" <<'HTML'
<!doctype html>
<html>
<head><title>Browser Control Live Fixture</title></head>
<body>
  <h1>Browser Control Live Fixture</h1>
  <form id="fixture-form">
    <input id="email" type="email" placeholder="Enter email">
    <select id="role"><option value="user">User</option><option value="admin">Admin</option></select>
    <label><input id="active" type="checkbox"> Active</label>
    <button id="submit" type="button">Submit</button>
  </form>
  <pre id="state">not-submitted</pre>
  <a id="download" href="/download.txt" download="browser-control-live-download.txt">Download</a>
  <script>
    setTimeout(() => {
      const dynamic = document.createElement('button');
      dynamic.id = 'dynamic';
      dynamic.textContent = 'Dynamic Ready';
      document.body.appendChild(dynamic);
    }, 150);
    document.getElementById('submit').addEventListener('click', async () => {
      const payload = await fetch('/api.json').then(r => r.json());
      document.getElementById('state').textContent = JSON.stringify({
        email: document.getElementById('email').value,
        role: document.getElementById('role').value,
        active: document.getElementById('active').checked,
        api: payload.ok
      });
    });
  </script>
</body>
</html>
HTML
  printf '{"ok":true,"source":"live-fixture"}\n' > "$TMP_DIR/api.json"
  printf 'browser-control live download\n' > "$TMP_DIR/download.txt"
}

start_fixture() {
  write_fixture
  python3 -m http.server "$FIXTURE_PORT" --bind 127.0.0.1 --directory "$TMP_DIR" >/tmp/browser-control-live-fixture.log 2>&1 &
  FIXTURE_PID="$!"
  for _ in {1..30}; do
    if curl -fsS "$FIXTURE_URL/index.html" >/dev/null 2>&1; then
      return
    fi
    sleep 0.1
  done
  red "Fixture server did not start on $FIXTURE_URL"
  exit 1
}

# ─── Test 1: Daemon health ───────────────────────────────────────────

info "Test 1: Daemon health check"
if ! HEALTH=$(curl -fsS "$DAEMON_URL/health"); then
  red "Daemon not running at $DAEMON_URL."
  red "Start it with: cd $REPO_ROOT && browser-control start"
  exit 1
fi
RUNNING=$(echo "$HEALTH" | jq -r '.running // false')
check "daemon running" "true" "$RUNNING"

if [[ "$RUNNING" != "true" ]]; then
  red "Daemon not running. Start with: browser-control start"
  exit 1
fi

# ─── Test 2: Extension connection ─────────────────────────────────────

info "Test 2: Extension connection"
EXT_CONNECTED=$(echo "$HEALTH" | jq -r '.extensionConnected // false')
if [[ "$EXT_CONNECTED" != "true" ]]; then
  red "Extension not connected. Load the extension in Chrome, then rerun this command."
  red "Chrome handoff:"
  red "  1. Open chrome://extensions"
  red "  2. Enable Developer mode"
  red "  3. Load unpacked: $EXTENSION_PATH"
  red "  4. Confirm $DAEMON_URL/health reports extensionConnected=true"
  exit 2
fi
check "extension connected" "true" "$EXT_CONNECTED"

start_fixture

# ─── Test 3: Navigate ─────────────────────────────────────────────────

info "Test 3: Navigate to local fixture page"
NAV_RESULT=$(api_call "navigate" "{\"url\":\"$FIXTURE_URL/index.html\",\"newTab\":true}")
NAV_OK=$(echo "$NAV_RESULT" | jq -r '.ok // false')
check "navigate ok" "true" "$NAV_OK"

TAB_ID=$(echo "$NAV_RESULT" | jq -r '.data.tabId // ""')
info "  Tab ID: $TAB_ID"

# ─── Test 4: Snapshot ─────────────────────────────────────────────────

info "Test 4: Take accessibility snapshot"
SNAP_RESULT=$(api_call "snapshot" '{}')
SNAP_OK=$(echo "$SNAP_RESULT" | jq -r '.ok // false')
ELEMENT_COUNT=$(echo "$SNAP_RESULT" | jq -r '.data.totalElements // 0')
check "snapshot ok" "true" "$SNAP_OK"
info "  Elements found: $ELEMENT_COUNT"

# Find the input and button elements
INPUT_REF=$(echo "$SNAP_RESULT" | jq -r '.data.elements[]? | select(.tag=="input" and .attributes.type=="email") | .id' | head -1)
BUTTON_REF=$(echo "$SNAP_RESULT" | jq -r '.data.elements[]? | select(.tag=="button" and (.visibleText // "" | contains("Submit"))) | .id' | head -1)
info "  Input @ref: $INPUT_REF"
info "  Button @ref: $BUTTON_REF"

if [[ -z "$INPUT_REF" || "$INPUT_REF" == "null" ]]; then
  red "  Could not find input element. Snapshot may not contain expected elements."
  FAIL=$((FAIL + 1))
else
  check "input element found" "$INPUT_REF" "$INPUT_REF"
fi

# ─── Test 5: Fill ─────────────────────────────────────────────────────

if [[ -n "$INPUT_REF" && "$INPUT_REF" != "null" ]]; then
  info "Test 5: Fill in the email input"
  FILL_RESULT=$(api_call "fill" "{\"selector\":\"$INPUT_REF\",\"value\":\"test@agentbrowser.dev\"}")
  FILL_OK=$(echo "$FILL_RESULT" | jq -r '.ok // false')
  FILL_MODE=$(echo "$FILL_RESULT" | jq -r '.data.mode // "unknown"')
  check "fill ok" "true" "$FILL_OK"
  info "  Fill mode: $FILL_MODE"
fi

# ─── Test 6: Select, check, wait, press, click ────────────────────────

info "Test 6: Interact with form controls"
SELECT_RESULT=$(api_call "select_option" '{"selector":"#role","value":"admin"}')
check "select_option ok" "true" "$(echo "$SELECT_RESULT" | jq -r '.ok // false')"
CHECK_RESULT=$(api_call "set_checked" '{"selector":"#active","checked":true}')
check "set_checked ok" "true" "$(echo "$CHECK_RESULT" | jq -r '.ok // false')"
WAIT_RESULT=$(api_call "wait_for" '{"selector":"#dynamic","timeoutMs":5000}')
check "wait_for ok" "true" "$(echo "$WAIT_RESULT" | jq -r '.ok // false')"
PRESS_RESULT=$(api_call "press" '{"selector":"#email","key":"Enter"}')
check "press ok" "true" "$(echo "$PRESS_RESULT" | jq -r '.ok // false')"

if [[ -n "$BUTTON_REF" && "$BUTTON_REF" != "null" ]]; then
  info "Test 7: Click the submit button and trigger fixture API request"
  NETWORK_START=$(api_call "network_start" "{\"filter\":\"$FIXTURE_URL/api.json\"}")
  check "network_start ok" "true" "$(echo "$NETWORK_START" | jq -r '.ok // false')"
  CLICK_RESULT=$(api_call "click" "{\"selector\":\"$BUTTON_REF\"}")
  CLICK_OK=$(echo "$CLICK_RESULT" | jq -r '.ok // false')
  check "click ok" "true" "$CLICK_OK"
  sleep 1
else
  red "  FAIL: submit button element missing"
  FAIL=$((FAIL + 1))
fi

# ─── Test 8: Evaluate JavaScript state ────────────────────────────────

info "Test 8: Evaluate JavaScript in page"
EVAL_ARGS=$(jq -nc --arg code 'return fetch("/api.json").then(r => r.json()).then(api => { const state = { title: document.title, email: document.getElementById("email").value, role: document.getElementById("role").value, active: document.getElementById("active").checked, api: api.ok }; document.getElementById("state").textContent = JSON.stringify(state); return state; });' '{code:$code}')
EVAL_RESULT=$(api_call "evaluate" "$EVAL_ARGS")
EVAL_OK=$(echo "$EVAL_RESULT" | jq -r '.ok // false')
check "evaluate ok" "true" "$EVAL_OK"
check_true "evaluated fixture state includes API result" "$(echo "$EVAL_RESULT" | jq -r '(.data.result.api // false)')"

# ─── Test 9: Screenshot artifact via API ──────────────────────────────

info "Test 9: Take screenshot and verify artifact metadata"
SCREENSHOT_RESULT=$(api_call "screenshot" '{"format":"png"}')
SCREENSHOT_OK=$(echo "$SCREENSHOT_RESULT" | jq -r '.ok // false')
check "screenshot ok" "true" "$SCREENSHOT_OK"
check "screenshot raw base64 stripped" "null" "$(echo "$SCREENSHOT_RESULT" | jq -r '.data.data // null')"
check "screenshot artifact kind" "screenshot" "$(echo "$SCREENSHOT_RESULT" | jq -r '.artifacts[0].kind // ""')"
SCREENSHOT_PATH=$(echo "$SCREENSHOT_RESULT" | jq -r '.artifacts[0].path // ""')
if [[ -n "$SCREENSHOT_PATH" && -f "$SCREENSHOT_PATH" ]]; then
  check_true "screenshot artifact file exists" "true"
else
  red "  FAIL: screenshot artifact file missing: $SCREENSHOT_PATH"
  FAIL=$((FAIL + 1))
fi

# ─── Test 10: PDF artifact if Chrome debugger permission is available ─

info "Test 10: Save PDF and verify artifact metadata when available"
PDF_RESULT=$(api_call "save_as_pdf" '{"file_name":"browser-control-live.pdf"}')
PDF_OK=$(echo "$PDF_RESULT" | jq -r '.ok // false')
if [[ "$PDF_OK" == "true" ]]; then
  check "pdf raw base64 stripped" "null" "$(echo "$PDF_RESULT" | jq -r '.data.data // null')"
  check "pdf artifact kind" "pdf" "$(echo "$PDF_RESULT" | jq -r '.artifacts[0].kind // ""')"
  PDF_PATH=$(echo "$PDF_RESULT" | jq -r '.artifacts[0].path // ""')
  if [[ -n "$PDF_PATH" && -f "$PDF_PATH" ]]; then
    check_true "pdf artifact file exists" "true"
  else
    red "  FAIL: pdf artifact file missing: $PDF_PATH"
    FAIL=$((FAIL + 1))
  fi
else
  skip "PDF generation unavailable in this Chrome/permission state: $(echo "$PDF_RESULT" | jq -r '.error.message // .error // "unknown"')"
fi

# ─── Test 11: Network capture summaries and detail IDs ────────────────

info "Test 11: Network capture list/detail"
NETWORK_LIST=$(api_call "network_list" "{\"filter\":\"$FIXTURE_URL/api.json\"}")
check "network_list ok" "true" "$(echo "$NETWORK_LIST" | jq -r '.ok // false')"
REQUEST_ID=$(echo "$NETWORK_LIST" | jq -r '.data.requests[0].id // ""')
if [[ -n "$REQUEST_ID" && "$REQUEST_ID" != "null" ]]; then
  NETWORK_DETAIL=$(api_call "network_detail" "{\"requestId\":\"$REQUEST_ID\"}")
  check "network_detail ok" "true" "$(echo "$NETWORK_DETAIL" | jq -r '.ok // false')"
  check "network_detail preserves request id" "$REQUEST_ID" "$(echo "$NETWORK_DETAIL" | jq -r '.data.id // .data.requestId // ""')"
else
  red "  FAIL: network request id missing"
  FAIL=$((FAIL + 1))
fi
NETWORK_STOP=$(api_call "network_stop" '{}')
check "network_stop ok" "true" "$(echo "$NETWORK_STOP" | jq -r '.ok // false')"

# ─── Test 12: Direct download command artifact metadata ───────────────

info "Test 12: Download fixture artifact"
if [[ "${BROWSER_CONTROL_LIVE_TEST_DOWNLOAD:-0}" == "1" ]]; then
  DOWNLOAD_RESULT=$(api_call "download" "{\"url\":\"$FIXTURE_URL/download.txt\",\"filename\":\"browser-control-live-download.txt\"}")
  DOWNLOAD_OK=$(echo "$DOWNLOAD_RESULT" | jq -r '.ok // false')
  if [[ "$DOWNLOAD_OK" == "true" ]]; then
    DOWNLOAD_STATE=$(echo "$DOWNLOAD_RESULT" | jq -r '.data.state // ""')
    DOWNLOAD_KIND=$(echo "$DOWNLOAD_RESULT" | jq -r '.artifacts[0].kind // .data.artifacts[0].kind // ""')
    if [[ "$DOWNLOAD_KIND" == "download" ]]; then
      check "download artifact kind" "download" "$DOWNLOAD_KIND"
    else
      skip "download completed without local artifact path in this Chrome state (state=$DOWNLOAD_STATE)"
    fi
  else
    skip "download unavailable in this Chrome/permission state: $(echo "$DOWNLOAD_RESULT" | jq -r '.error.message // .error // "unknown"')"
  fi
else
  skip "download test disabled by default to avoid Chrome save dialogs; set BROWSER_CONTROL_LIVE_TEST_DOWNLOAD=1 to enable"
fi

# ─── Test 13: Multi-tab sessions ─────────────────────────────────────

info "Test 13: Multi-tab session metadata"
SECOND_NAV=$(api_call "navigate" "{\"url\":\"$FIXTURE_URL/index.html?tab=2\",\"newTab\":true}")
check "second tab navigate ok" "true" "$(echo "$SECOND_NAV" | jq -r '.ok // false')"
LIST_RESULT=$(api_call "list_tabs" '{}')
LIST_OK=$(echo "$LIST_RESULT" | jq -r '.ok // false')
TAB_COUNT=$(echo "$LIST_RESULT" | jq -r '.data.tabs | length // 0')
check "list_tabs ok" "true" "$LIST_OK"
if [[ "$TAB_COUNT" -ge 2 ]]; then
  check_true "session has multiple tabs" "true"
else
  red "  FAIL: expected at least 2 session tabs, got $TAB_COUNT"
  FAIL=$((FAIL + 1))
fi
info "  Tabs in session: $TAB_COUNT"

# ─── Test 14: Close session ───────────────────────────────────────────

info "Test 14: Close session"
CLOSE_RESULT=$(api_call "close_session" '{}')
CLOSE_OK=$(echo "$CLOSE_RESULT" | jq -r '.ok // false')
check "close_session ok" "true" "$CLOSE_OK"

# ─── Summary ──────────────────────────────────────────────────────────

echo ""
echo "=========================="
echo " Test Results"
echo "=========================="
echo -e " Passed: $(green $PASS)"
echo -e " Failed: $(red $FAIL)"
echo -e " Skipped: $(yellow $SKIP)"
echo " Total:  $((PASS + FAIL + SKIP))"
echo ""

if [[ "$FAIL" -eq 0 ]]; then
  green "All tests passed!"
  exit 0
else
  red "$FAIL test(s) failed."
  exit 1
fi
