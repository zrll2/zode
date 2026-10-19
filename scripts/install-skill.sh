#!/bin/bash
# Install the delegate-to-zcode skill for Claude Code (user level), pointing at this Zode checkout.
set -euo pipefail
ZODE_HOME="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}/delegate-to-zcode"
mkdir -p "$DEST" "$HOME/.zode"
printf '%s\n' "$ZODE_HOME" > "$HOME/.zode/home"
for f in SKILL.md order-template.md; do
  sed "s#__ZODE_HOME__#$ZODE_HOME#g" "$ZODE_HOME/skill/delegate-to-zcode/$f" > "$DEST/$f"
done
echo "Skill installed: $DEST"
