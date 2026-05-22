#!/usr/bin/env bash
# Browser Control — Extension Diagnostic Script
# Checks if the Chrome Extension is installed and enabled.
set -euo pipefail

CHROME_EXTENSION_ID="${CODEX_CHROME_EXTENSION_ID:-jfmjfhklogoienhpfnppmbcbjfjnkonk}"
CHROME_USER_DATA="${CODEX_CHROME_USER_DATA_DIR:-$HOME/Library/Application Support/Google/Chrome}"
JSON_OUTPUT=false

usage() {
  cat <<'EOF'
Usage: check-extension.sh [--json]

Check if the Browser Control Chrome Extension is installed and enabled.
EOF
}

for arg in "$@"; do
  case "$arg" in
    --json) JSON_OUTPUT=true ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; usage; exit 2 ;;
  esac
done

# ─── Find Chrome profile ──────────────────────────────────────────────

find_chrome_profile() {
  local user_data="$1"

  # Check "Local State" for last used profile
  local local_state="$user_data/Local State"
  if [[ -f "$local_state" ]]; then
    local profile
    profile=$(python3 -c "
import json,sys
try:
  d=json.load(open('$local_state'))
  p=d.get('profile',{})
  print(p.get('last_used') or p.get('last_active_profiles',['Default'])[-1])
except: print('Default')
" 2>/dev/null || echo "Default")
    if [[ -d "$user_data/$profile" ]] && [[ -f "$user_data/$profile/Preferences" ]]; then
      echo "$profile"
      return
    fi
  fi

  # Fallback to Default or Profile N
  for dir in "$user_data/Default" "$user_data"/Profile\ *; do
    if [[ -d "$dir" ]] && [[ -f "$dir/Preferences" ]]; then
      basename "$dir"
      return
    fi
  done

  echo "Default"
}

PROFILE_DIR=$(find_chrome_profile "$CHROME_USER_DATA")
PREFERENCES_FILE="$CHROME_USER_DATA/$PROFILE_DIR/Preferences"
SECURE_PREFERENCES="$CHROME_USER_DATA/$PROFILE_DIR/Secure Preferences"

# ─── Check extension state ────────────────────────────────────────────

check_extension() {
  for prefs in "$SECURE_PREFERENCES" "$PREFERENCES_FILE"; do
    [[ -f "$prefs" ]] || continue

    local ext_data
    ext_data=$(python3 -c "
import json,sys
try:
  d=json.load(open('$prefs'))
  settings=d.get('extensions',{}).get('settings',{})
  ext=settings.get('$CHROME_EXTENSION_ID')
  ext_id='$CHROME_EXTENSION_ID'
  matched_by='configured-id'
  if not ext:
    for candidate_id,candidate in settings.items():
      manifest=candidate.get('manifest',{})
      name=(manifest.get('name') or manifest.get('short_name') or '')
      p=str(candidate.get('path') or '')
      if 'Browser Control' in name or 'browser-control' in p.lower():
        ext=candidate
        ext_id=candidate_id
        matched_by='manifest-or-path'
        break
  if not ext:
    sys.exit(1)
  print(json.dumps({
    'installed': True,
    'extensionId': ext_id,
    'configuredExtensionId': '$CHROME_EXTENSION_ID',
    'matchedBy': matched_by,
    'state': ext.get('state'),
    'path': ext.get('path'),
    'manifest': ext.get('manifest',{}).get('name'),
    'version': ext.get('manifest',{}).get('version')
  }))
except:
  sys.exit(1)
" 2>/dev/null) || continue

    echo "$ext_data"
    return 0
  done
  return 1
}

EXT_DATA=$(check_extension) || true

if [[ -z "$EXT_DATA" ]]; then
  if $JSON_OUTPUT; then
    echo "{\"installed\":false,\"extensionId\":\"$CHROME_EXTENSION_ID\",\"profilePath\":\"$CHROME_USER_DATA/$PROFILE_DIR\"}"
  else
    echo "Browser Control Extension Check"
    echo "====================================="
    echo "Profile: $CHROME_USER_DATA/$PROFILE_DIR"
    echo "Extension ID: $CHROME_EXTENSION_ID"
    echo "Installed: NO"
    echo ""
    echo "Install the extension from chrome://extensions/ using 'Load unpacked'."
  fi
  exit 2
fi

if $JSON_OUTPUT; then
  echo "$EXT_DATA" | jq --arg profile "$PROFILE_DIR" \
    '{profilePath: $profile} + .'
else
  echo "Browser Control Extension Check"
  echo "====================================="
  echo "Profile: $CHROME_USER_DATA/$PROFILE_DIR"
  echo "Extension ID: $(echo "$EXT_DATA" | jq -r '.extensionId // "unknown"')"
  echo "Installed: YES"
  echo "State: $(echo "$EXT_DATA" | jq -r '.state // "unknown"')"
  echo "Version: $(echo "$EXT_DATA" | jq -r '.version // "unknown"')"
fi

exit 0
