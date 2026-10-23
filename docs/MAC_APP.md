# Zode for Mac: the standalone app (plan)

Status: planned. Today the phone relay, the menu bar icon and the pairing window live inside a patched copy of ZCode (`Zode.app`). This plan moves them into their own app, **Zode for Mac**, signed with a Developer ID certificate and notarized by Apple, distributed as a direct download (not the Mac App Store: the store's sandbox forbids patching another app and reading `~/.zcode-tap`, and Zode.app is a modified copy of someone else's product).

## Two apps
| | Zode (new) | ZCode Engine (built on your Mac) |
|---|---|---|
| What | menu bar app: relay, pairing, phones, setup, updates | your own ZCode, copied, with a small wrapper that exposes the agent on a local socket |
| Bundle id | `dev.zode.mac` | `dev.zode.engine` |
| Path | `/Applications/Zode.app` | `/Applications/ZCode Engine.app` |
| Made by | us (Electron, Developer ID, notarized) | `scripts/build-tap.sh` on the user's Mac, ad-hoc signed; we never ship ZCode's code |
| Needs ZCode running | no: relay and pairing keep running when the ZCode window is closed | yes: it is the app you use ZCode in |

Why split: the relay survives ZCode restarts, relay fixes ship through the app's own update without rebuilding ZCode, and the Engine is only rebuilt when ZCode itself updates.

The phone talks to the relay exactly as before (protocol unchanged). The relay talks to the agent through `~/.zcode-tap/*.sock`, exactly as before.

## Phases
1. **Split.** `mac/`: standalone Electron app (tray, pairing window, relay, settings). `scripts/build-tap.sh`: Engine mode (no relay or tray inside, new name and bundle id). The update scripts learn the Engine path.
2. **First-run setup** — built: the `mac/` wizard finds ZCode, builds the Engine, waits for sign-in + an open project, pairs the phone, and offers to Trash the old `Zode.app` (settings and paired phones in `~/.zode` carry over by themselves).
3. **Updates** — built: ZCode updates via `scripts/update-zcode.sh` (rebuilds the Engine) and Zode updates itself via `electron-updater` from GitHub Releases (`zrll2/zode`), with a one-click restart from the menu.
4. **Sign and notarize.** electron-builder, hardened runtime, entitlements, `notarytool`, `stapler`, DMG. Certificate: Developer ID Application, GOOLOO PTE LTD (JLB545UV6D). arm64 first.
5. **Distribute.** GitHub Releases, README download button, Homebrew cask.
6. **Clean up.** Remove `macapp/` and the asar patching once nothing uses them.

Built along the way: the menu bar icon opens a small panel (left click) — the native menu remains as the right-click fallback.

## Decisions made
- Electron (reuse the tested JavaScript; ~100 MB download is fine). A native rewrite stays possible later because the phone protocol does not change.
- Publisher shown to users: GOOLOO PTE LTD.
- Not on the Mac App Store.

## Open risks
- ZCode's licence terms for a locally built, patched copy are unverified.
- Intel Macs (manifest platform name `darwin-x64`) are unverified.
- Notarization may reject unusual bundled files; expect a round or two of fixes.
