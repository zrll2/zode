#!/bin/bash
# zode install: check prerequisites, install dependencies, build Zode.app, install the Claude Code skill.
# ZODE_ENGINE=1 builds ZCode Engine.app instead (see scripts/build-tap.sh).
set -euo pipefail
ZODE_HOME="$(cd "$(dirname "$0")/.." && pwd)"
ENGINE=0
if [ "${ZODE_ENGINE:-}" = "1" ]; then ENGINE=1; fi
ok(){ printf '  \033[32m✓\033[0m %s\n' "$1"; }; bad(){ printf '  \033[31m✗\033[0m %s\n' "$1" >&2; exit 1; }
echo "Zode install"
[ "$(uname)" = "Darwin" ] || bad "macOS only for now."
command -v node >/dev/null || bad "Node.js 20 or newer is required."
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ] || bad "Node.js 20 or newer is required (found $(node -v))."
ok "node $(node -v)"
command -v git >/dev/null || bad "git is required."; ok "git"
[ -d "${ZCODE_APP:-/Applications/ZCode.app}" ] || bad "ZCode is not installed at ${ZCODE_APP:-/Applications/ZCode.app}. Install it, or set ZCODE_APP."
ok "ZCode found"
command -v claude >/dev/null && ok "Claude Code found" || echo "  - Claude Code CLI not found on PATH (the skill still installs; install Claude Code to use it)"

echo "Installing dependencies ..."
( cd "$ZODE_HOME/bridge" && npm install --omit=dev --no-audit --no-fund --silent ) && ok "bridge"
( cd "$ZODE_HOME/relay"  && npm install --omit=dev --no-audit --no-fund --silent ) && ok "relay"

if [ "$ENGINE" -eq 1 ]; then
  echo "Building ZCode Engine.app ..."
else
  echo "Building Zode.app ..."
fi
"$ZODE_HOME/scripts/build-tap.sh"
"$ZODE_HOME/scripts/install-skill.sh"

if [ "$ENGINE" -eq 1 ]; then
cat <<NEXT

Done. Next:
  1. Quit ZCode if open, then:  open /Applications/ZCode Engine.app   (log in once, open any project)
  2. Start the Zode menu bar app:  cd mac && npm install && npm start   (until the packaged app exists)
  3. ./zode doctor
NEXT
else
cat <<NEXT

Done. Next:
  1. Quit ZCode if it is open, then:  open /Applications/Zode.app   (log in once, open any project)
  2. ./zode doctor
  3. In Claude Code, say: "Delegate this to ZCode: <your task>"
NEXT
fi
