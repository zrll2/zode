# Watch app

Status: spike in progress

## Architecture

A watchOS target lives next to the phone app and talks to it over WatchConnectivity.
The message names are `snapshot`, `prompt` and `result`; this spike only builds the
`snapshot` slice plus a `hello` ping (the `prompt`/`result` pair — watch asks the
phone to run something and gets the outcome back — comes later).

| Direction | Message | Payload |
| --- | --- | --- |
| watch → phone | `hello` | `{ type: "hello", at: <epoch ms> }` — sent with `WCSession.sendMessage` (reply handler), falling back to `transferUserInfo` when the phone is not reachable |
| phone → watch | `snapshot` | `{ ok: true, status: <relay status>, servers: <count>, sessions: [{ id, project, title, state: "needs" \| "working" \| "idle" }] }` — at most 8 rows, needs-you first; sent as the `hello` reply and pushed with `updateApplicationContext` on every list/status change (throttled to one per 2 s) |

- **Phone** — `src/watchBridge.ts`: pure `buildWatchSnapshot({ sessions, status, servers })`
  (unit-tested in `__tests__/watchBridge.test.ts`) and `useWatchBridge()`, mounted once in
  `app/_layout.tsx` inside the relay provider. Everything is guarded: no watch, Expo Go,
  Android, or demo mode can never crash the app. The session list comes from the same
  `session/list` rpc the home list uses.
- **Watch** — `targets/watch/` (picked up by `@bacons/apple-targets`):
  `PhoneLink.swift` owns the `WCSession` delegate (activate on launch, reachability,
  application context, messages), `ContentView.swift` renders the status line, the
  `Say hello` button, the reply line (`Phone says: connected to N Mac servers`) and up to
  5 rows with a state dot, and `expo-target.config.js` describes the target
  (bundle id `com.zode.app.watch`, watchOS 10+, team JLB545UV6D).

## Spike notes

Files added by this spike:

- `targets/watch/expo-target.config.js`, `targets/watch/ZodeWatchApp.swift`,
  `targets/watch/PhoneLink.swift`, `targets/watch/ContentView.swift`
- `src/watchBridge.ts`, mounted in `app/_layout.tsx`
- `app.json`: `@bacons/apple-targets` plugin entry

Build (exact commands are run by hand): `npx expo prebuild -p ios --clean`, then
`pod install`, then run the `ZodeWatch` scheme on a watchOS simulator paired with an
iOS simulator from Xcode. All target files live outside `ios/`; every
`expo prebuild --clean` re-links them (see the `@bacons/apple-targets` README).
