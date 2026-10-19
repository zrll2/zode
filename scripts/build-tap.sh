#!/bin/bash
# Build "Zode.app": a copy of your ZCode app whose agent can also be reached over a local socket.
# The original ZCode is not touched. Nothing from ZCode is stored in this repository.
#   ZCODE_APP   source app   (default /Applications/ZCode.app)
#   ZODE_TAP_APP destination (default /Applications/Zode.app, or ~/Applications if /Applications is not writable)
set -euo pipefail
SRC="${ZCODE_APP:-/Applications/ZCode.app}"
if [ -w /Applications ]; then DEFAULT_DST="/Applications/Zode.app"; else DEFAULT_DST="$HOME/Applications/Zode.app"; fi
DST="${ZODE_TAP_APP:-$DEFAULT_DST}"
GLM="$DST/Contents/Resources/glm"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LEGACY="$HOME/Applications/ZCode-Tap.app"; LEGACY2="$HOME/Applications/Zode.app"   # name used before the app was called Zode

[ -d "$SRC" ] || { echo "ZCode not found at $SRC. Install ZCode first, or set ZCODE_APP." >&2; exit 1; }
[ -f "$SRC/Contents/Resources/glm/zcode.cjs" ] || { echo "$SRC does not look like ZCode (no Resources/glm/zcode.cjs)." >&2; exit 1; }
if pgrep -f "$DST/Contents/Frameworks" >/dev/null 2>&1; then
  echo "$DST is running. Quit it (Cmd+Q), then run this again." >&2; exit 1
fi

echo "Copying $(basename "$SRC") ($(du -sh "$SRC" | cut -f1)) to $DST ..."
mkdir -p "$(dirname "$DST")"
rm -rf "$DST"
ditto "$SRC" "$DST"
xattr -cr "$DST"

# Name and icon: Finder and the Dock show "Zode", with the Zode logo.
# Leave CFBundleName as it is: Electron uses it to find its helper processes, and the app crashes on launch without it.
PLIST="$DST/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName Zode" "$PLIST" 2>/dev/null || /usr/libexec/PlistBuddy -c "Add :CFBundleDisplayName string Zode" "$PLIST"
# Own bundle id, so the Dock does not merge Zode.app with the original ZCode (which would show ZCode's icon).
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier dev.zode.app" "$PLIST"
[ -f "$ROOT/assets/Zode.icns" ] && cp "$ROOT/assets/Zode.icns" "$DST/Contents/Resources/icon.icns"
# ZCode also sets its Dock icon from icon.png at runtime, so replace that too.
[ -f "$ROOT/assets/logo.png" ] && sips -z 1024 1024 "$ROOT/assets/logo.png" --out "$DST/Contents/Resources/icon.png" >/dev/null 2>&1 || true

# Keep the real CLI, put a small shim in its place.
mv "$GLM/zcode.cjs" "$GLM/zcode.real.cjs"
mkdir -p "$GLM/provider"
cp "$DST/Contents/Resources/config/provider/zcode-builtin.json" "$GLM/provider/zcode-builtin.json"
cat > "$GLM/zcode.cjs" <<'SHIM'
// Zode shim. In `app-server` mode it runs the agent through Zode's tee wrapper; every other mode runs the real CLI unchanged.
// The wrapper lives in the Zode repo (path in ~/.zode/home), so wrapper updates need no rebuild. If Zode is gone, ZCode still works.
const path = require('path'), fs = require('fs'), os = require('os'), { pathToFileURL } = require('url');
const real = path.join(__dirname, 'zcode.real.cjs');
const args = process.argv.slice(2);
let wrapper = null;
try {
  const home = fs.readFileSync(path.join(os.homedir(), '.zode', 'home'), 'utf8').trim();
  const w = path.join(home, 'bridge', 'agent-wrapper.mjs');
  if (fs.existsSync(w)) wrapper = w;
} catch {}
if (wrapper && args[0] === 'app-server' && !args.includes('--prepare-storage') && !process.env.ZODE_TAP_OFF) {
  process.env.ZCODE_TAP_CLI = real;
  import(pathToFileURL(wrapper).href);
} else {
  require(real);
}
SHIM
chmod +x "$GLM/zcode.cjs"

# The Zode integration inside the app: the phone relay, menu bar icon and pairing window.
# Installs macapp/dist into $DST/Contents/Resources/zode and patches the asar's main to boot.cjs.
npm install --prefix "$ROOT/macapp" --no-fund --no-audit
npm install --prefix "$ROOT/relay" --no-fund --no-audit
node "$ROOT/macapp/install.mjs" "$DST"

echo "Signing (ad hoc) ..."
codesign --force --deep -s - "$DST" >/dev/null 2>&1
codesign --verify --deep "$DST" 2>/dev/null && echo "Built $DST"
for OLD in "$LEGACY" "$LEGACY2"; do
  if [ "$OLD" != "$DST" ] && [ -d "$OLD" ] && ! pgrep -f "$OLD/Contents/Frameworks" >/dev/null 2>&1; then
    rm -rf "$OLD" && echo "Removed the old copy at $OLD (replaced by $DST)."
  fi
done
