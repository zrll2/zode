# Work order 19: the relay serves a static web client (browser access)

You write code. Claude Code supervises and runs every command. You cannot run commands or delete files; skip any step that needs one and say so.
Edit only inside the current directory. Do not commit. No new dependencies, no secrets, no network calls.

## Read first
`relay/service.mjs` (the `handle` function ~line 633, `createRelay` options, `stop`), `relay/test/service.test.mjs` (how a relay is started on a free port in tests), `relay/README.md`, `mac/main.mjs` (where `createRelay({...})` is built ~line 281, `settings`), `mac/lib/settings.mjs`, `mac/panel/index.html` + `panel.js` (Settings switches: `#swKeepAwake` style rows, `setSwitch`, `flip`, the `toggle` panel action keys), `mac/package.json` (electron-builder `extraResources`).

## Goal
A browser (for example on a Linux computer reaching this Mac over Tailscale) can open `http://<mac address>:8787/` and get the Zode web client, then pair with the normal one-time code. The relay only serves files; every protocol rule stays.

## Design (use exactly this)
1. `createRelay({ webDir })`: optional absolute directory. When absent or not a directory, behaviour is unchanged (404 for everything but /health and /pair).
2. In `handle`, after /health and /pair: for `GET` and `HEAD` only, serve files from `webDir`:
   - Resolve the path from `new URL(req.url, 'http://x').pathname`, decode, reject (404) anything with `..`, a NUL byte, a backslash, or that resolves outside `webDir` (`path.resolve` + prefix check with a path separator). No directory listings; `/` maps to `index.html`.
   - A path without a file extension that does not exist falls back to `index.html` (single-page routing); a path with an extension that does not exist is 404.
   - Content types by extension: html, js, css, json, png, jpg, svg, ico, woff, woff2, ttf, map, txt, webmanifest; default `application/octet-stream`. Max file size 20 MB (else 404). Stream with `fs.createReadStream`; errors never throw.
   - Headers on every served response: `x-content-type-options: nosniff`, `referrer-policy: no-referrer`, `x-frame-options: DENY`, `content-security-policy: default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws: wss:; media-src 'self' blob:; frame-ancestors 'none'`, `cache-control: no-cache` for html and `public, max-age=3600` for hashed assets under `/_expo/`.
   - No `access-control-allow-*` headers anywhere (same origin only). The /pair route is unchanged.
3. `mac/lib/settings.mjs`: new boolean `webClient`, default false (add it to defaults and validation like the others).
4. `mac/main.mjs`: when `settings.webClient === true` and the folder `path.join(process.resourcesPath, 'web')` (dev: `path.join(__dirname, 'web')` if it exists) is a directory, pass it as `webDir` to `createRelay`. Changing the setting restarts the relay the same way an address change does (find the existing helper; do not invent a new restart path). Add `webClient` to the `toggle` panel action keys and to the settings payload in `mac/lib/panel.mjs`.
5. `mac/panel/index.html` + `panel.js`: one new Settings switch row "Browser access" in the same group as the other switches, same pattern, no description text.
6. `mac/package.json`: add `web` to electron-builder `extraResources` only if the folder `mac/web` exists at build; use `"filter"` so a missing folder is not an error (if electron-builder cannot do that, leave it and say so).

## Tests
- relay: serves index.html at `/` and at an unknown route without extension; 404 for missing file with extension; path traversal attempts (`/../x`, `/%2e%2e/x`, `/a/..%2f..%2fx`, encoded NUL) all 404; HEAD works; headers present; no `access-control-allow-origin`; with no `webDir` everything stays 404; /health and /pair still work.
- mac: settings default `webClient:false`; panel payload carries it; main wiring regex test for the toggle and `webDir`.

## Rules
Do not change protocol frames, pairing, auth, risk, audit, defaults of any other setting, or the phone app.
Reply with the single line: `webserve done`.
