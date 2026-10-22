# Zode for Mac

`mac/` is the standalone **Zode** menu bar app (Electron, bundle id `dev.zode.mac`). It runs the phone
relay in its own process — no ZCode window, no patching, no booting of ZCode.

## Run it

```
cd mac
npm install
npm start        # builds dist/ with esbuild, then `electron dist`
```

The Dock icon is hidden in development (`app.dock.hide()`); the packaged app will use `LSUIElement`
instead (a later step). Tests: `npm test`.

## What it does

- **First-run wizard** (`Set up Zode…` in the menu, opens by itself when setup is not finished):
  finds ZCode (or links to the download), builds the ZCode Engine copy with a progress bar, waits
  for you to sign in and open a project, pairs your phone, and offers to move the old `Zode.app` to
  the Trash.
- Starts the relay (`../relay/service.mjs`) in-process on the address and port from the settings. The
  relay finds the agent through the unix sockets in `~/.zcode-tap/*.json|*.sock` that the Engine
  exposes, so it never needs a ZCode process of its own.
- Tray menu: relay state, a `ZCode connected` / `Waiting for ZCode` line, `Pair a phone…`, paired
  phones, `Relay on`, `Reachable from`, launch at login, `Keep my Mac awake while Zode is on` (a
  sleeping Mac drops the phone), `Set up ZCode…`, `Open ZCode…`, `About Zode`, `Quit Zode`. The menu
  is rebuilt on every click.
- Pairing window with QR code (one-time code, five minutes).
- Settings in `~/.zode/settings.json` (mode 0600), log in `~/.zode/mac-app.log`.

Only one Zode runs at a time (single-instance lock); launching it again just shows the pairing window
of the running one.

## The Engine

The Engine is your own ZCode exposing the agent on `~/.zcode-tap`. The wizard builds it by running
`scripts/build-tap.sh` with `ZODE_ENGINE=1` from the kit (the repo in development,
`Resources/engine-kit` when packaged), writing the kit path to `~/.zode/home` first. On a Mac with
more than one copy of ZCode, only one may run at a time — the wizard and the launch dialog offer to
quit the original or the old integrated `Zode.app` when they are in the way. Settings and paired
phones live in `~/.zode/` and are shared with the old app, so phones keep working across the switch.
`macapp/` — the relay inside ZCode — stays as it is until a later phase removes it.
