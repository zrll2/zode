# Zode for Mac: the standalone app (plan)

Status: planned. Today the phone relay, the menu bar icon and the pairing window live inside a patched copy of ZCode (`Zode.app`). This plan moves them into their own app, **Zode for Mac**, signed with a Developer ID certificate and notarized by Apple, distributed as a direct download (not the Mac App Store: the store's sandbox forbids patching another app and reading `~/.zcode-tap`, and Zode.app is a modified copy of someone else's product).

## One app you open, one it keeps
You only see Zode. The Engine is a private copy of ZCode that Zode builds and keeps in its own folder (no Launchpad icon, no Spotlight hit), and opens from the Z button. Zode downloads and checks new ZCode releases itself, so the original ZCode.app is not needed (and never touched).

| | Zode | The Engine (built on your Mac) |
|---|---|---|
| What | menu bar app: relay, pairing, phones, setup, updates | your own ZCode, copied, with a small wrapper that exposes the agent on a local socket |
| Bundle id | `dev.zode.mac` | `dev.zode.engine` |
| Path | `/Applications/Zode.app` | `~/Library/Application Support/Zode/engine.noindex/ZCode.app` |
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

## Claude Code feed (built)

Zode appends one JSON line per notification decision (finished, failed, needs you, stuck) to `~/.zode/events.jsonl` (mode 0600, rotated at 512 KB to `events.jsonl.1`). Each line is `{ v, at, kind, sessionId, project, title, workspace }` — states and names only, never commands or message text. The feed runs whether or not macOS notifications are on; it is independent of their pacing and merging.

The app also installs a Claude Code skill, `~/.claude/skills/zode-results/SKILL.md`, which tells any Claude Code session to run the shipped watcher (`mac/bin/zode-watch.mjs`, launched through the app binary with `ELECTRON_RUN_AS_NODE=1`) as a Monitor. The watcher tails the feed and prints one plain line per event (`finished: <project> - <title> (session <id>)`). The skill is marked `managed-by: zode` and rewritten on every launch; turning the `Tell Claude Code` switch off in Settings removes it (only if it still carries the marker) and stops the feed. Developers: `ELECTRON_RUN_AS_NODE` must stay enabled — no Electron fuse disabling it is set in `mac/electron-builder.yml`.

## Decisions made
- Electron (reuse the tested JavaScript; ~100 MB download is fine). A native rewrite stays possible later because the phone protocol does not change.
- Publisher shown to users: GOOLOO PTE LTD.
- Not on the Mac App Store.

## Open risks
- ZCode's licence terms for a locally built, patched copy are unverified.
- Intel Macs (manifest platform name `darwin-x64`) are unverified.
- Notarization may reject unusual bundled files; expect a round or two of fixes.
