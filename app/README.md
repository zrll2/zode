# Zode

Zode is an unofficial companion for the ZCode desktop app. It is an Expo (SDK 58)
app with expo-router that controls ZCode sessions on a Mac through the
[`relay`](../relay/README.md).

## Design

The UI follows [`docs/DESIGN.md`](docs/DESIGN.md): calm paper background, serif titles
(Source Serif 4), one clay accent, no cards or boxes — hierarchy comes from type and
spacing. Tokens live in `src/theme.ts`, shared components in `src/ui/`.

## Run

```bash
npm install
npx expo install --fix   # align dependency versions with the installed Expo SDK
npx expo start
```

Press `i` to open the iOS simulator (or scan the QR code with Expo Go on a device).

- `npm test` — jest suite in `__tests__/` (reducer, pairing, relay client)
- `npm run typecheck` — `tsc --noEmit`

## Pair

On the Mac, in the Zode folder:

```bash
./zode pair
```

Scan the printed QR code in the app (camera permission prompt), or paste the pairing
text `{"u":…,"w":…,"c":…}` into the text box. Pairing codes work once and expire in
5 minutes. `./zode devices` lists paired phones, `./zode revoke <id>`
removes one.

A pairing carries every address the Mac relay listens on (`urls`: the Wi-Fi/LAN
address and the Tailscale address). The phone stores them all and connects over
whichever answers first — at home that is Wi-Fi, away it rolls over to Tailscale
by itself, and back again when the Wi-Fi returns. Each `ready` frame re-announces
the relay's current addresses (`addresses`), so the stored list stays fresh. Tap
the Mac chip on the home screen to see how you are connected ("Connected over
Wi-Fi" / "Connected over Tailscale").

The device token is stored in the iOS Keychain / Android Keystore via
`expo-secure-store`. It is only ever sent inside the first WebSocket `auth` frame —
never logged, never put in a URL.

## Cleartext traffic note

The relay has no TLS: it speaks plain `ws://` / `http://` and is meant to run on a
private network (Tailscale/WireGuard), never bound to `0.0.0.0` on an untrusted LAN
and never port-forwarded. The app therefore allows cleartext loads —
`NSAppTransportSecurity.NSAllowsArbitraryLoads = true` on iOS and
`usesCleartextTraffic = true` on Android, both set in `app.json`. Tighten these if
you ever put the relay behind TLS.

## Modes

New sessions are offered only in `plan` or `edit` mode — the relay refuses
`yolo`/`build`, and `guarded`-mode permission prompts can only be answered on the
desktop. When an event shows a permission request, the chat shows a read-only notice
pointing at the Mac.
