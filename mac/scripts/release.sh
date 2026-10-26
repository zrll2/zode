#!/bin/bash
# Build, sign, notarize and staple Zode for Mac.   bash scripts/release.sh [--no-notarize]
# Needs: the Developer ID Application certificate in the login keychain (Comex Technologies Pte Ltd) and, for notarization,
# a notarytool keychain profile named "zode-notary":
#   xcrun notarytool store-credentials zode-notary --key AuthKey_XXXX.p8 --key-id XXXX --issuer <issuer-uuid>
set -euo pipefail
cd "$(dirname "$0")/.."
NOTARIZE=1; [ "${1:-}" = "--no-notarize" ] && NOTARIZE=0
PROFILE="${ZODE_NOTARY_PROFILE:-zode-notary}"

npm install --no-audit --no-fund
npm install --prefix ../relay --no-audit --no-fund --omit=dev
bash scripts/build-whisper.sh        # builds vendor/whisper-cli, packaged as Resources/bin/whisper-cli
node build.mjs
rm -rf release
npx electron-builder --mac --arm64 --publish never

APP="release/mac-arm64/Zode.app"
DMG="$(ls release/*.dmg | head -n 1)"
codesign --verify --deep --strict --verbose=2 "$APP"
echo "Signed: $(codesign -dv --verbose=2 "$APP" 2>&1 | grep -E 'Authority=Developer ID Application' | head -n 1)"

if [ "$NOTARIZE" -eq 0 ]; then echo "Skipping notarization (--no-notarize). The app will be blocked by Gatekeeper on other Macs."; exit 0; fi
if [ -n "${ZODE_NOTARY_KEY:-}" ]; then   # an App Store Connect API key file instead of a stored keychain profile (ZODE_NOTARY_KEY, ZODE_NOTARY_KEY_ID, ZODE_NOTARY_ISSUER)
  xcrun notarytool submit "$DMG" --key "$ZODE_NOTARY_KEY" --key-id "$ZODE_NOTARY_KEY_ID" --issuer "$ZODE_NOTARY_ISSUER" --wait
else
  xcrun notarytool submit "$DMG" --keychain-profile "$PROFILE" --wait
fi
xcrun stapler staple "$DMG"
spctl -a -t open --context context:primary-signature -vv "$DMG"
echo "Release ready: $DMG"
