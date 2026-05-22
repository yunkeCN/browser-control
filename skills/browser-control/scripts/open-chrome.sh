#!/usr/bin/env bash
# Browser Control — Open Chrome Window
# Opens a Chrome window for the same profile used by the extension checks.
set -euo pipefail

CHROME_USER_DATA="${CODEX_CHROME_USER_DATA_DIR:-$HOME/Library/Application Support/Google/Chrome}"
DRY_RUN=false
JSON_OUTPUT=false

usage() {
  cat <<'EOF'
Usage: open-chrome.sh [--dry-run] [--json]

Open a Chrome window for the active Chrome profile.
Useful when the daemon cannot connect to the extension.
EOF
}

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --json) JSON_OUTPUT=true ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; usage; exit 2 ;;
  esac
done

# Find Chrome
CHROME_APP=""
if [[ -d "/Applications/Google Chrome.app" ]]; then
  CHROME_APP="/Applications/Google Chrome.app"
elif CHROME_PATH=$(command -v google-chrome 2>/dev/null || command -v google-chrome-stable 2>/dev/null); then
  CHROME_APP="$CHROME_PATH"
else
  echo "Error: Google Chrome not found." >&2
  exit 1
fi

# Find profile directory
find_chrome_profile() {
  local user_data="$1"
  local local_state="$user_data/Local State"
  if [[ -f "$local_state" ]]; then
    local profile
    profile=$(python3 -c "
import json
d=json.load(open('$local_state'))
p=d.get('profile',{})
print(p.get('last_used') or 'Default')
" 2>/dev/null || echo "Default")
    if [[ -d "$user_data/$profile" ]]; then
      echo "$profile"
      return
    fi
  fi
  echo "Default"
}

PROFILE_DIR=$(find_chrome_profile "$CHROME_USER_DATA")

if $JSON_OUTPUT; then
  jq -n \
    --arg chrome "$CHROME_APP" \
    --arg profile "$PROFILE_DIR" \
    --argjson dryRun "$DRY_RUN" \
    '{chrome: $chrome, profileDirectory: $profile, dryRun: $dryRun}'
  exit 0
fi

echo "Opening Chrome (profile: $PROFILE_DIR)..."

if $DRY_RUN; then
  echo "[DRY RUN] Would run: open -n -a '$CHROME_APP' --args --profile-directory=$PROFILE_DIR --new-window about:blank"
  exit 0
fi

if [[ "$CHROME_APP" == *.app ]]; then
  open -n -a "$CHROME_APP" --args --profile-directory="$PROFILE_DIR" --new-window about:blank
else
  "$CHROME_APP" --profile-directory="$PROFILE_DIR" --new-window about:blank &
fi

echo "Chrome launched. Wait a moment for the extension to connect."
