#!/bin/bash
# Update the original ZCode from the official release manifest, then rebuild the copy from it
# (ZCode Engine.app, or an old integrated Zode.app — the Zode menu bar app is not touched).
#
# Why not ZCode's own updater: it aborts while any copy of the app is still running, and it cannot
# install over the re-signed Zode.app at all. This script fetches the same zip the updater would
# use, verifies it (size, SHA-512, Developer ID signature, Team ID equal to the installed app's),
# and only then quits the apps and replaces anything on disk. A failed step leaves the previous
# state in place (or restores it).
#
#   ZCODE_APP          original app (default /Applications/ZCode.app)
#   ZODE_APP           the copy to update and rebuild. When unset: /Applications/ZCode Engine.app
#                      (~/Applications when /Applications is not writable), else an old integrated
#                      Zode.app (one with Contents/Resources/zode/boot.cjs), else the plain Zode.app
#                      default — same path rule as scripts/build-tap.sh
#   ZODE_STANDALONE=1  Zode owns ZCode: there is no original ZCode.app to update. The newest release is
#                      downloaded, verified against ZCode's pinned Team ID and used to build the Engine
#                      (ZODE_APP, default ~/Library/Application Support/Zode/engine.noindex/ZCode.app)
#                      directly. "Installed" means the Engine's version. /Applications/ZCode.app is never touched.
#   ZODE_NO_OPEN=1     do not reopen the copy at the end (for tests)
#   ZODE_NO_NOTIFY=1   no macOS failure notification
#
# Everything printed is also appended, one timestamped line at a time, to ~/.zode/update.log.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
ORIG_APP="${ZCODE_APP:-/Applications/ZCode.app}"
STANDALONE="${ZODE_STANDALONE:-0}"
PINNED_TEAM="8A5X4JJ39T"      # ZCode's Developer ID Team ID: a download must be signed by it
STANDALONE_APP="$HOME/Library/Application Support/Zode/engine.noindex/ZCode.app"
if [ -n "${ZODE_APP:-}" ]; then ZODE_APP_PATH="$ZODE_APP"
elif [ "$STANDALONE" = "1" ]; then ZODE_APP_PATH="$STANDALONE_APP"
else
  if [ -d "/Applications/ZCode Engine.app" ]; then ZODE_APP_PATH="/Applications/ZCode Engine.app"
  elif [ -d "$HOME/Applications/ZCode Engine.app" ]; then ZODE_APP_PATH="$HOME/Applications/ZCode Engine.app"
  elif [ -d "/Applications/Zode.app" ] && [ -f "/Applications/Zode.app/Contents/Resources/zode/boot.cjs" ]; then ZODE_APP_PATH="/Applications/Zode.app"
  elif [ -d "$HOME/Applications/Zode.app" ] && [ -f "$HOME/Applications/Zode.app/Contents/Resources/zode/boot.cjs" ]; then ZODE_APP_PATH="$HOME/Applications/Zode.app"
  elif [ -w /Applications ]; then ZODE_APP_PATH="/Applications/Zode.app"
  else ZODE_APP_PATH="$HOME/Applications/Zode.app"; fi
fi
UPDATES_DIR="$HOME/.zode/updates"
LOG_FILE="$HOME/.zode/update.log"
MANIFEST_URL="https://zcode.z.ai/api/v1/releases/electron/manifest"
ARCH="$(uname -m)"

# Keep the real stderr aside: the confirmation prompt and the download progress must reach the
# terminal even though main() runs with its stderr piped into the logging loop at the bottom.
exec 9>&2

CHECK=0; YES=0; NO_REBUILD=0; WAIT_PID=""
ZIP_PATH="" EXTRACT_TMP="" BUILD_TMP="" BAK_PATH="" NEW_APP=""
INSTALLED="" ZODE_VER="" LATEST="" ZIP_URL="" ZIP_SHA="" ZIP_SIZE=""

usage() {
  cat <<'USAGE'
Usage: update-zcode.sh [--check] [--yes] [--no-rebuild] [--pid N]

  --check        print one JSON line (installed, latest, available, zode) and exit
  --yes          update without asking for confirmation
  --no-rebuild   update the original ZCode but leave the copy (Engine or Zode.app) untouched
  --pid N        wait (at most 60 s) for process N to exit first; used when the copy launches
                 this script and quits itself

Environment: ZCODE_APP, ZODE_APP, ZODE_NO_OPEN=1, ZODE_NO_NOTIFY=1. Log: ~/.zode/update.log
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK=1 ;;
    --yes) YES=1 ;;
    --no-rebuild) NO_REBUILD=1 ;;
    --pid) if [ $# -lt 2 ]; then echo "error: --pid needs a process id" >&2; exit 2; fi; WAIT_PID="$2"; shift ;;
    --pid=*) WAIT_PID="${1#--pid=}" ;;
    -h|--help) usage; exit 0 ;;
    *) echo "error: unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done
case "$WAIT_PID" in
  '') : ;;
  *[!0-9]*) echo "error: --pid needs a numeric process id" >&2; exit 2 ;;
esac

fail() {  # fail <step> <reason>: report, notify (best effort), exit 1
  local step="$1" reason="$2"
  echo "FAILED at step $step: $reason" >&2
  if [ "${ZODE_NO_NOTIFY:-0}" != "1" ] && [ -z "${SSH_CONNECTION:-}" ] && command -v osascript >/dev/null 2>&1; then
    osascript -e 'display notification "ZCode update failed. See ~/.zode/update.log" with title "Zode"' >/dev/null 2>&1 || true
  fi
  exit 1
}

quit_app() {  # quit_app <apple-script bundle id (may be empty)> <pgrep pattern>: quit gracefully, then kill
  local app_id="$1" pattern="$2" n=0
  if [ -n "$app_id" ] && pgrep -f "$pattern" >/dev/null 2>&1; then
    osascript -e "tell application id \"$app_id\" to quit" >/dev/null 2>&1 || true
    while pgrep -f "$pattern" >/dev/null 2>&1 && [ "$n" -lt 10 ]; do
      n=$((n + 1)); sleep 1
    done
  fi
  if pgrep -f "$pattern" >/dev/null 2>&1; then
    pkill -f "$pattern" >/dev/null 2>&1 || true
    n=0
    while pgrep -f "$pattern" >/dev/null 2>&1 && [ "$n" -lt 5 ]; do
      n=$((n + 1)); sleep 1
    done
  fi
}

app_version() {  # app_version <app path>: CFBundleShortVersionString, empty when unreadable
  local app="$1"
  if [ ! -d "$app" ]; then return 0; fi
  /usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$app/Contents/Info.plist" 2>/dev/null || true
}

app_bundle_id() {  # app_bundle_id <app path>: CFBundleIdentifier, empty when unreadable
  local app="$1"
  if [ ! -d "$app" ]; then return 0; fi
  /usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$app/Contents/Info.plist" 2>/dev/null || true
}

app_team_id() {  # app_team_id <app path>: codesign TeamIdentifier, empty when unsigned
  codesign -dv --verbose=2 "$1" 2>&1 | sed -n 's/^TeamIdentifier=//p' | head -n 1 || true
}

json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  printf '%s' "$s"
}

version_gt() {  # version_gt <a> <b>: true when a > b, compared numerically per dot part
  local a="$1" b="$2"
  local -a pa pb
  local IFS='.'
  read -r -a pa <<< "$a"
  read -r -a pb <<< "$b"
  local i max x y
  if [ "${#pa[@]}" -gt "${#pb[@]}" ]; then max="${#pa[@]}"; else max="${#pb[@]}"; fi
  for ((i = 0; i < max; i++)); do
    x="${pa[i]:-0}"; x="${x%%[!0-9]*}"; x="${x:-0}"
    y="${pb[i]:-0}"; y="${y%%[!0-9]*}"; y="${y:-0}"
    if [ "$x" -gt "$y" ]; then return 0; fi
    if [ "$x" -lt "$y" ]; then return 1; fi
  done
  return 1
}

manifest_fatal() {  # manifest problems: --check exits 3 with a stderr message, the update fails at step 1
  if [ "$CHECK" -eq 1 ]; then echo "error: $1" >&2; exit 3; fi
  fail 1 "$1"
}

read_manifest() {  # sets LATEST, ZIP_URL, ZIP_SHA, ZIP_SIZE from the .zip entry of the manifest
  local platform manifest entry
  case "$ARCH" in
    arm64) platform="darwin-aarch64" ;;
    x86_64) platform="darwin-x64" ;;
    *) manifest_fatal "unsupported architecture: $ARCH" ;;
  esac
  manifest="$(curl -fsSL --max-time 15 "$MANIFEST_URL?platform=$platform&channel=stable" | tr -d '\r')" \
    || manifest_fatal "could not fetch the release manifest from zcode.z.ai"
  LATEST="$(printf '%s\n' "$manifest" | sed -n 's/^version:[[:space:]]*//p' | head -n 1 || true)"
  case "$LATEST" in
    ''|*[!0-9A-Za-z._-]*) manifest_fatal "the manifest has no usable version (got: ${LATEST:-nothing})" ;;
  esac
  entry="$(printf '%s\n' "$manifest" | awk '
    BEGIN { infiles = 0; url = ""; sha = ""; size = "" }
    /^files:/ { infiles = 1; next }
    infiles && /^[^ \t]/ { infiles = 0; url = ""; sha = ""; size = "" }
    infiles && /- url:/ { url = $0; sub(/.*- url:[ \t]*/, "", url); sha = ""; size = ""; next }
    infiles && url != "" && /^[ \t]+sha512:/ { sha = $0; sub(/.*sha512:[ \t]*/, "", sha); next }
    infiles && url != "" && /^[ \t]+size:/ { size = $0; sub(/.*size:[ \t]*/, "", size); if (url ~ /\.zip$/ && sha != "") { print url "\t" sha "\t" size; exit } next }
  ')"
  ZIP_URL=""; ZIP_SHA=""; ZIP_SIZE=""
  IFS=$'\t' read -r ZIP_URL ZIP_SHA ZIP_SIZE <<< "$entry" || true
  case "$ZIP_URL" in
    https://*.zip|http://*.zip) : ;;
    *) manifest_fatal "the manifest has no usable .zip entry" ;;
  esac
  case "$ZIP_SHA" in
    ''|*[!A-Za-z0-9+/=]*) manifest_fatal "the .zip entry has no usable sha512" ;;
  esac
  case "$ZIP_SIZE" in
    ''|*[!0-9]*) manifest_fatal "the .zip entry has no usable size" ;;
  esac
}

recover_backup() {  # a leftover .ZCode-*.bak means a previous run died mid-swap: repair first
  local parent bak
  parent="$(dirname "$ORIG_APP")"
  for bak in "$parent/".ZCode-*.bak; do
    if [ ! -e "$bak" ]; then continue; fi
    if [ -d "$ORIG_APP" ] && codesign --verify --deep --strict "$ORIG_APP" >/dev/null 2>&1; then
      echo "Removing a leftover backup ($bak); ZCode.app is intact."
      rm -rf "$bak"
    else
      echo "Found $bak from an interrupted run; ZCode.app is missing or damaged. Restoring the backup first."
      rm -rf "$ORIG_APP"
      if ! mv "$bak" "$ORIG_APP"; then
        fail 0 "could not restore the backup $bak"
      fi
      echo "Restored the previous ZCode from $bak."
    fi
  done
}

wait_for_pid() {
  local n=0
  echo "Waiting for process $WAIT_PID to quit ..."
  while kill -0 "$WAIT_PID" 2>/dev/null; do
    n=$((n + 1))
    if [ "$n" -ge 60 ]; then fail 0 "process $WAIT_PID did not exit within 60 s"; fi
    sleep 1
  done
}

cleanup() {  # temp folders only: the download stays for --retry resume, the backup until step 7
  if [ -n "${EXTRACT_TMP:-}" ] && [ -d "$EXTRACT_TMP" ]; then rm -rf "$EXTRACT_TMP"; fi
  if [ -n "${BUILD_TMP:-}" ] && [ -d "$BUILD_TMP" ]; then rm -rf "$BUILD_TMP"; fi
}

read_installed() {
  ZODE_VER="$(app_version "$ZODE_APP_PATH")"
  if [ "$STANDALONE" = "1" ]; then INSTALLED="$ZODE_VER"; else INSTALLED="$(app_version "$ORIG_APP")"; fi
}

print_check() {
  local inst_json="null" zode_json="null" avail="false"
  if [ -n "$INSTALLED" ]; then inst_json="\"$(json_escape "$INSTALLED")\""; fi
  if [ -n "$ZODE_VER" ]; then zode_json="\"$(json_escape "$ZODE_VER")\""; fi
  if [ -n "$INSTALLED" ] && version_gt "$LATEST" "$INSTALLED"; then avail="true"; fi
  printf '{"installed":%s,"latest":"%s","available":%s,"zode":%s}\n' \
    "$inst_json" "$(json_escape "$LATEST")" "$avail" "$zode_json"
}

confirm_update() {
  local answer
  if [ "$YES" -eq 1 ]; then return 0; fi
  if [ ! -t 0 ]; then
    fail 1 "no terminal to confirm the update; rerun with --yes"
  fi
  printf 'Update ZCode %s -> %s and rebuild %s? [y/N] ' "$INSTALLED" "$LATEST" "$TARGET_LABEL" >&9
  read -r answer
  case "$answer" in
    y|Y|yes|Yes|YES) return 0 ;;
    *) echo "Cancelled."; exit 0 ;;
  esac
}

download_step() {  # step 2
  local mb rc=0 actual_size actual_sha
  mkdir -p "$UPDATES_DIR"
  ZIP_PATH="$UPDATES_DIR/ZCode-$LATEST-$ARCH.zip"
  mb=$(( (ZIP_SIZE + 524288) / 1048576 ))
  echo "[2/7] Downloading ZCode $LATEST ($mb MB)"
  if [ -t 9 ]; then
    curl -fL --retry 3 -C - --progress-bar -o "$ZIP_PATH" "$ZIP_URL" 2>&9 || rc=$?
  else
    curl -fsSL --retry 3 -C - -o "$ZIP_PATH" "$ZIP_URL" || rc=$?
  fi
  if [ "$rc" -ne 0 ]; then
    rm -f "$ZIP_PATH"
    if [ "$rc" -eq 130 ]; then fail 2 "interrupted"; fi
    fail 2 "download failed (curl exit $rc)"
  fi
  actual_size="$(stat -f%z "$ZIP_PATH" 2>/dev/null || echo 0)"
  if [ "$actual_size" != "$ZIP_SIZE" ]; then
    rm -f "$ZIP_PATH"
    fail 2 "downloaded $actual_size bytes, expected $ZIP_SIZE (download deleted)"
  fi
  actual_sha="$(openssl dgst -sha512 -binary "$ZIP_PATH" | base64 | tr -d '\n')"
  if [ "$actual_sha" != "$ZIP_SHA" ]; then
    rm -f "$ZIP_PATH"
    fail 2 "SHA-512 mismatch (download deleted)"
  fi
}

verify_step() {  # step 3: nothing outside ~/.zode/updates is touched here
  local new_ver new_team want_team
  echo "[3/7] Verifying the download (version, signature, Team ID)"
  EXTRACT_TMP="$(mktemp -d "$UPDATES_DIR/extract.XXXXXXXX")" || fail 3 "could not create a temp folder"
  if ! ditto -xk "$ZIP_PATH" "$EXTRACT_TMP"; then
    rm -rf "$EXTRACT_TMP"; EXTRACT_TMP=""
    rm -f "$ZIP_PATH"
    fail 3 "could not extract the zip (download deleted)"
  fi
  NEW_APP="$EXTRACT_TMP/ZCode.app"
  if [ ! -d "$NEW_APP" ]; then
    rm -f "$ZIP_PATH"
    fail 3 "the zip does not contain ZCode.app"
  fi
  new_ver="$(app_version "$NEW_APP")"
  if [ "$new_ver" != "$LATEST" ]; then
    rm -f "$ZIP_PATH"
    fail 3 "the extracted app reports version ${new_ver:-none}, expected $LATEST"
  fi
  if ! codesign --verify --deep --strict "$NEW_APP" >/dev/null 2>&1; then
    rm -f "$ZIP_PATH"
    fail 3 "codesign --verify --deep --strict rejected the downloaded app"
  fi
  if ! spctl -a -t exec "$NEW_APP" >/dev/null 2>&1; then
    rm -f "$ZIP_PATH"
    fail 3 "Gatekeeper (spctl) rejected the downloaded app"
  fi
  new_team="$(app_team_id "$NEW_APP")"
  if [ "$STANDALONE" = "1" ]; then want_team="$PINNED_TEAM"; else want_team="$(app_team_id "$ORIG_APP")"; fi
  if [ -z "$new_team" ] || [ -z "$want_team" ] || [ "$new_team" != "$want_team" ]; then
    rm -f "$ZIP_PATH"
    fail 3 "Team ID mismatch (download: ${new_team:-none}, installed: ${want_team:-none})"
  fi
}

quit_step() {  # step 4: any surviving process breaks the swap
  echo "[4/7] Quitting ZCode and ${TARGET_LABEL%.app}"
  if [ "$STANDALONE" != "1" ]; then quit_app "dev.zcode.app" "$ORIG_APP/"; fi
  quit_app "$ZODE_APP_ID" "$ZODE_APP_PATH/"     # bundle id read from the target's Info.plist
  # The Zode menu bar app (bundle id dev.zode.mac) is deliberately not quit: its relay keeps running.
  if [ "$STANDALONE" != "1" ] && pgrep -f "$ORIG_APP/" >/dev/null 2>&1; then
    fail 4 "ZCode is still running ($ORIG_APP); quit it and rerun"
  fi
  if pgrep -f "$ZODE_APP_PATH/" >/dev/null 2>&1; then
    fail 4 "$TARGET_LABEL is still running ($ZODE_APP_PATH); quit it and rerun"
  fi
}

restore_backup() {  # restore_backup <step> <reason>: put the old app back, then fail
  rm -rf "$ORIG_APP"
  if [ -n "${BAK_PATH:-}" ] && [ -e "$BAK_PATH" ]; then
    mv "$BAK_PATH" "$ORIG_APP" 2>/dev/null || true
  fi
  fail "$1" "$2"
}

replace_step() {  # step 5
  if [ "$STANDALONE" = "1" ]; then echo "[5/7] Keeping the verified download for the Engine build"; return 0; fi
  local parent bak
  parent="$(dirname "$ORIG_APP")"
  echo "[5/7] Replacing $ORIG_APP with $LATEST"
  if [ ! -w "$parent" ]; then
    fail 5 "cannot write to $parent; run with sudo or move ZCode.app to ~/Applications"
  fi
  bak="$parent/.ZCode-$INSTALLED.bak"
  BAK_PATH="$bak"
  if [ -d "$ORIG_APP" ] && ! mv "$ORIG_APP" "$bak"; then
    fail 5 "could not move the old ZCode aside"
  fi
  if ! ditto "$NEW_APP" "$ORIG_APP"; then
    restore_backup 5 "could not copy the new ZCode into place"
  fi
  xattr -dr com.apple.quarantine "$ORIG_APP" 2>/dev/null || true
  if ! codesign --verify --deep --strict "$ORIG_APP" >/dev/null 2>&1; then
    restore_backup 5 "the new ZCode did not pass verification after the swap; the old version is back"
  fi
  rm -rf "$EXTRACT_TMP"; EXTRACT_TMP=""
}

rebuild_zode() {  # build into a temp folder first, so a failed build never removes the old copy
  local tmp_app rc=0
  mkdir -p "$UPDATES_DIR"
  export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"  # build-tap.sh needs node; a GUI app's PATH may lack it
  BUILD_TMP="$(mktemp -d "$UPDATES_DIR/rebuild.XXXXXXXX")" || fail 6 "could not create a temp folder"
  tmp_app="$BUILD_TMP/$(basename "$ZODE_APP_PATH")"
  if [ "$IS_ENGINE" -eq 1 ]; then
    local src="$ORIG_APP"; if [ "$STANDALONE" = "1" ] && [ -n "${NEW_APP:-}" ]; then src="$NEW_APP"; fi
    if ! ZCODE_APP="$src" ZODE_TAP_APP="$tmp_app" ZODE_ENGINE=1 bash "$REPO/scripts/build-tap.sh"; then rc=1; fi
  else
    if ! ZODE_TAP_APP="$tmp_app" bash "$REPO/scripts/build-tap.sh"; then rc=1; fi
  fi
  if [ "$rc" -ne 0 ]; then
    rm -rf "$BUILD_TMP"; BUILD_TMP=""
    echo "Rebuilding $TARGET_LABEL failed. The new ZCode is installed; your existing copy is unchanged."
    echo "Fix: cd \"$REPO\" && ./zode install"
    fail 6 "scripts/build-tap.sh failed"
  fi
  local old="$ZODE_APP_PATH.old"
  if [ -d "$ZODE_APP_PATH" ] && ! mv "$ZODE_APP_PATH" "$old"; then
    rm -rf "$BUILD_TMP"; BUILD_TMP=""
    fail 6 "could not move the old $TARGET_LABEL aside"
  fi
  mkdir -p "$(dirname "$ZODE_APP_PATH")"
  if ! mv "$tmp_app" "$ZODE_APP_PATH"; then
    if [ -e "$old" ] && [ ! -e "$ZODE_APP_PATH" ]; then mv "$old" "$ZODE_APP_PATH" 2>/dev/null || true; fi
    rm -rf "$BUILD_TMP"; BUILD_TMP=""
    fail 6 "could not move the new $TARGET_LABEL into place"
  fi
  rm -rf "$old" "$BUILD_TMP"; BUILD_TMP=""
}

open_zode() {
  if [ "${ZODE_NO_OPEN:-0}" = "1" ]; then return 0; fi
  open "$ZODE_APP_PATH" 2>/dev/null || true
}

finish_step() {  # step 7
  echo "[7/7] Cleaning up and opening ${TARGET_LABEL%.app}"
  if [ -n "${BAK_PATH:-}" ] && [ -e "$BAK_PATH" ]; then rm -rf "$BAK_PATH"; fi
  if [ -n "${ZIP_PATH:-}" ] && [ -e "$ZIP_PATH" ]; then rm -f "$ZIP_PATH"; fi
  open_zode
  local zv
  zv="$(app_version "$ZODE_APP_PATH")"
  if [ -n "$zv" ]; then
    echo "Done: ZCode $LATEST and ${TARGET_LABEL%.app} $zv"
  else
    echo "Done: ZCode $LATEST (${TARGET_LABEL%.app} version unknown)"
  fi
}

up_to_date_flow() {  # the original is current; still refresh the copy when it lags behind
  echo "ZCode is up to date ($INSTALLED)"
  if [ "$NO_REBUILD" -eq 1 ]; then return 0; fi
  if [ -n "$ZODE_VER" ] && ! version_gt "$INSTALLED" "$ZODE_VER"; then
    echo "$TARGET_LABEL is up to date ($ZODE_VER)"
    return 0
  fi
  echo "Rebuilding $TARGET_LABEL from ZCode $INSTALLED (current copy: ${ZODE_VER:-none})"
  quit_app "$ZODE_APP_ID" "$ZODE_APP_PATH/"
  if pgrep -f "$ZODE_APP_PATH/" >/dev/null 2>&1; then
    fail 6 "$TARGET_LABEL is still running ($ZODE_APP_PATH); quit it and rerun"
  fi
  rebuild_zode
  open_zode
  local zv
  zv="$(app_version "$ZODE_APP_PATH")"
  if [ -n "$zv" ]; then
    echo "Done: ZCode $INSTALLED and ${TARGET_LABEL%.app} $zv"
  else
    echo "Done: ZCode $INSTALLED (${TARGET_LABEL%.app} version unknown)"
  fi
}

# What is the target copy? Its bundle id decides: dev.zode.engine is an Engine (rebuilt with
# ZODE_ENGINE=1), anything else is the old integrated Zode.app. The Zode menu bar product app
# (bundle id dev.zode.mac) is never a target here and is never quit by the update.
ZODE_APP_ID="$(app_bundle_id "$ZODE_APP_PATH")"
IS_ENGINE=0
if [ "$ZODE_APP_ID" = "dev.zode.engine" ] || [ "$STANDALONE" = "1" ]; then IS_ENGINE=1; fi
if [ "$IS_ENGINE" -eq 1 ]; then TARGET_LABEL="ZCode Engine.app"; else TARGET_LABEL="Zode.app"; fi

main() {
  trap cleanup EXIT
  cd /
  if [ "$CHECK" -eq 0 ]; then
    if [ -n "$WAIT_PID" ]; then wait_for_pid; fi
    if [ "$STANDALONE" != "1" ]; then recover_backup; fi
  fi
  read_installed
  read_manifest
  if [ "$CHECK" -eq 1 ]; then
    print_check
    exit 0
  fi
  if [ -z "$INSTALLED" ] && [ "$STANDALONE" != "1" ]; then
    fail 1 "ZCode not found at $ORIG_APP (install it first, or point ZCODE_APP at it)"
  fi
  echo "[1/7] Installed ZCode is ${INSTALLED:-none}; the latest release is $LATEST"
  if ! version_gt "$LATEST" "$INSTALLED"; then
    up_to_date_flow
    exit 0
  fi
  confirm_update
  download_step
  verify_step
  quit_step
  replace_step
  if [ "$NO_REBUILD" -eq 1 ]; then
    echo "Skipping the $TARGET_LABEL rebuild (--no-rebuild)"
  else
    echo "[6/7] Rebuilding $TARGET_LABEL from the new ZCode"
    rebuild_zode
  fi
  finish_step
}

# Run everything with stdout and stderr also appended, timestamped, to ~/.zode/update.log.
mkdir -p "$HOME/.zode"
main "$@" 2>&1 | while IFS= read -r line; do
  printf '%s\n' "$line"
  printf '%s %s\n' "$(date '+%F %T')" "$line" >> "$LOG_FILE"
done
exit "${PIPESTATUS[0]}"
