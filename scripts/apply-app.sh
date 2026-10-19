#!/bin/bash
# (Re-)apply the Zode integration to an existing Zode.app: the phone relay inside the app,
# the menu bar icon and the pairing window. Patches the asar main and re-signs (ad hoc).
#   scripts/apply-app.sh [path to Zode.app] [--uninstall]     default /Applications/Zode.app
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

APP=""
ARGS=()
for a in "$@"; do
  if [ -z "$APP" ] && [ "${a#-}" = "$a" ]; then APP="$a"; else ARGS+=("${a:-}"); fi
done
APP="${APP:-/Applications/Zode.app}"

[ -d "$APP" ] || { echo "No app at $APP. Build it first with ./zode install, or pass a path." >&2; exit 1; }
if pgrep -f "$APP/Contents/Frameworks" >/dev/null 2>&1 || pgrep -f "$APP/Contents/MacOS" >/dev/null 2>&1; then
  echo "$APP is running. Quit it first (Cmd+Q), then run this again." >&2
  exit 1
fi

[ -d "$ROOT/macapp/node_modules" ] || npm install --prefix "$ROOT/macapp" --no-fund --no-audit
node "$ROOT/macapp/install.mjs" "$APP" ${ARGS[@]+"${ARGS[@]}"}

echo "Signing (ad hoc) ..."
codesign --force --deep -s - "$APP" >/dev/null 2>&1
codesign --verify --deep "$APP"
echo "Done. Open $APP — the Zode icon is in the menu bar."
