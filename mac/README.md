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

- Starts the relay (`../relay/service.mjs`) in-process on the address and port from the settings. The
  relay finds the agent through the unix sockets in `~/.zcode-tap/*.json|*.sock` that the Engine
  exposes, so it never needs a ZCode process of its own.
- Tray menu: relay state, `Pair a phone…`, paired phones, `Relay on`, `Reachable from`, launch at
  login, `Open ZCode…`, `About Zode`, `Quit Zode`. The menu is rebuilt on every click.
- Pairing window with QR code (one-time code, five minutes).
- Settings in `~/.zode/settings.json` (mode 0600), log in `~/.zode/mac-app.log`.

Only one Zode runs at a time (single-instance lock); launching it again just shows the pairing window
of the running one.

## The Engine

The Engine is your own ZCode exposing the agent on `~/.zcode-tap`; it is built by
`scripts/build-tap.sh` (that script learns its Engine mode in the next step). Until
`/Applications/ZCode Engine.app` exists, Zode falls back to the legacy patched copy
`/Applications/Zode.app`. `macapp/` — the relay inside ZCode — stays as it is until a later phase
removes it.
