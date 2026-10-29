# Work order 20: run the phone app in a browser (Expo web)

You write code. Claude Code supervises and runs every command (install, tsc, jest, the web export). You cannot run commands or delete files; skip any step that needs one and say so.
Edit only inside the current directory. Do not commit. No secrets, no analytics. Do not add dependencies: Claude adds `react-native-web` and `@expo/metro-runtime` to package.json itself.

## Verified facts
- `npx expo export --platform web` already builds this app (with react-native-web) and the pair screen and demo mode render in a browser with no console errors.
- The web client is served by the Zode relay from the same origin at `/` (`http://<mac>:8787/`), so `POST /pair` and the websocket go to `location.origin` (http -> ws). The relay has no CORS and no TLS.
- Things that do not exist on web: `expo-secure-store` (keychain), push registration, the Apple Watch bridge, haptics, `expo-camera` QR scanning, `expo-notifications` tasks, `expo-task-manager`.

## Read first
`src/storage.ts`, `src/config.ts`, `src/pairing.ts`, `app/pair.tsx`, `src/useRelay.tsx`, `src/pushRegistration.ts`, `src/localNotify.ts`, `src/pushActions.ts`, `src/watchBridge.ts`, `src/voice.ts`, `app/_layout.tsx`, `app.json` (the `web` block), `package.json` (scripts), `__tests__/storage.test.ts` (if present) and how other tests mock `expo-secure-store` / `Platform`.

## Goal
`npm run export:web` produces a static site in `dist-web/` that works as a Zode client in desktop Chrome/Firefox on Linux: pair with a code, list sessions, open a conversation, send prompts, answer approvals. iOS and Android behaviour must stay byte-for-byte the same.

## Design
1. `src/storage.ts`: when `Platform.OS === 'web'`, store credentials (and the push key helpers become no-ops) in `window.localStorage` under the same key, wrapped in try/catch (a blocked storage reads as no credentials). Keep the native path untouched. Pure helpers stay testable.
2. Guards, each a one-line early return or a lazy `require` behind `Platform.OS !== 'web'`: `pushRegistration.ts`, `localNotify.ts`, `pushActions.ts`, `watchBridge.ts`, haptics calls (find them), `expo-task-manager` imports. No native module may be imported at module top level on web if it throws there (check each; the export already builds, so only runtime throws matter).
3. Pairing on web (`app/pair.tsx` + `src/pairing.ts`): the camera scanner is not offered. Show only the "paste" path, and on web a pasted bare code (digits/letters, no JSON) pairs with `location.origin` as the relay address (derive http and ws URLs from `window.location`: `http:`->`ws:`, `https:`->`wss:`); a pasted full pairing text keeps working. Device name `Browser`. A short pure function `webRelayFromLocation(loc)` in `src/pairing.ts`, tested.
4. Voice: if `expo-audio` recording cannot work on web, hide the microphone the same way it is hidden when `features.stt` is false; do not build a web recorder.
5. `package.json`: add script `"export:web": "expo export --platform web --output-dir dist-web"`. `app.json` `web.output` stays `single`. Add `dist-web/` to `.gitignore`.
6. Document in `README.md` (short section "Browser client"): export, copy to the Mac relay's web folder, Tailscale/LAN only, same pairing code flow.

## Tests (jest)
Storage web fallback (mock `Platform.OS = 'web'` and a fake localStorage: save/load/clear, blocked storage returns null, never throws), `webRelayFromLocation` (http, https, port, IPv6 literal), pairing a bare code on web, and that native storage still calls SecureStore.

## Rules
Do not change the relay protocol, src/relay, the watch targets, push-service, or iOS/Android config. Keep diffs small.
Reply with the single line: `web done`, then one line for any native module you found that still throws on web.
