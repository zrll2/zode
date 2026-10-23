#!/bin/bash
# Publish a notarized Zode for Mac release to GitHub (needs `gh auth login`, and a release already built by scripts/release.sh).
#   bash scripts/publish.sh            creates a DRAFT release v<version> with the DMG, ZIP, blockmaps and latest-mac.yml
#   bash scripts/publish.sh --publish  publishes it (the app's self-update only sees published releases)
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION="$(node -p "require('./package.json').version")"
TAG="v$VERSION"
DMG="release/Zode-$VERSION-arm64.dmg"
[ -f "$DMG" ] || { echo "No $DMG. Run scripts/release.sh first." >&2; exit 1; }
xcrun stapler validate "$DMG" >/dev/null 2>&1 || { echo "The DMG is not notarized and stapled. Run scripts/release.sh (without --no-notarize)." >&2; exit 1; }
FILES=("$DMG" "release/Zode-$VERSION-arm64-mac.zip" "release/Zode-$VERSION-arm64.dmg.blockmap" "release/Zode-$VERSION-arm64-mac.zip.blockmap" release/latest-mac.yml)
for f in "${FILES[@]}"; do [ -f "$f" ] || { echo "Missing $f" >&2; exit 1; }; done
if gh release view "$TAG" >/dev/null 2>&1; then echo "Release $TAG exists; uploading files."; gh release upload "$TAG" "${FILES[@]}" --clobber
else gh release create "$TAG" "${FILES[@]}" --draft --title "Zode for Mac $VERSION" --notes-file ../docs/RELEASE_NOTES.md; fi
if [ "${1:-}" = "--publish" ]; then gh release edit "$TAG" --draft=false; echo "Published $TAG"; else echo "Draft created. Review it on GitHub, then: bash scripts/publish.sh --publish"; fi
