# Work order 01: Expo React Native client for zcode-relay

You write code. Claude Code supervises and runs every command (install, tsc, jest, simulator). You cannot run commands. Edit files only inside the current directory.
Do not commit. Do not touch files outside the current directory. Do not add secrets. Do not add analytics or network calls other than the relay.

## Read first
- `RELAY_PROTOCOL.md`: the exact WebSocket and pairing protocol. Do not invent other frames.
- `fixtures/README.md` and `fixtures/events-sample.jsonl`: real event messages. Build the event reducer from these.

## Goal
A TypeScript Expo app (Expo SDK 58, expo-router) that lets the user control ZCode sessions on a Mac through the relay.

## Files to create
- `package.json` (name `zcode-mobile`; scripts: start, ios, android, test `jest`, typecheck `tsc --noEmit`; deps: expo ~58.0.14, expo-router ~58.0.23, expo-camera ~58.0.10, expo-secure-store ~58.0.2, expo-status-bar, react, react-native 0.88.0, react-native-safe-area-context, react-native-screens, expo-linking, expo-constants; dev: typescript, jest, jest-expo, @types/react, @types/jest). Claude will run `npx expo install --fix`, so exact versions can be approximate.
- `app.json` (name ZCode, scheme `zcode`, iOS bundle id `dev.zcode.mobile`, Android package `dev.zcode.mobile`, camera permission text, `userInterfaceStyle: automatic`, plugin `expo-router`, `expo-camera`, `expo-secure-store`). Allow cleartext `ws://` on iOS with `NSAppTransportSecurity` `NSAllowsArbitraryLoads` true (the relay runs on a private network without TLS) and on Android with `usesCleartextTraffic` true. Add a short comment in README explaining why.
- `tsconfig.json` (strict), `babel.config.js`, `jest.config.js` (preset jest-expo), `.gitignore` already exists.
- `src/relay/protocol.ts`: TypeScript types for every frame in RELAY_PROTOCOL.md.
- `src/relay/client.ts`: class `RelayClient`.
  - `connect()`: open WebSocket, send `{type:"auth", token, since}` first. Resolve when `ready` arrives.
  - `rpc(method, params, server?)`: returns a Promise; match `rpc-result` by id; reject on `error` or after 60 s.
  - `onEvent(cb)`, `onStatus(cb)` with states `connecting | ready | reconnecting | closed`.
  - Automatic reconnect with backoff 1 s, 2 s, 4 s ... max 30 s. On reconnect send `since` = last seen `seq`. Drop duplicate events (seq <= last seen).
  - On close code 4003 (bad token): stop, set status `closed`, expose `authFailed`.
  - Constructor takes a `WebSocket` factory so tests can pass a mock.
- `src/relay/reducer.ts`: pure function `reduce(state, event)` turning relay `event` frames into chat state for one session: list of items `{kind:"user"|"assistant"|"reasoning"|"tool"|"error"|"notice", ...}`, plus `running: boolean`, `lastResponse`. Rules: `model.streaming` deltas append to the current assistant or reasoning item; `tool.updated` updates a tool card by `toolCallId` (name, state); `turn.started` sets running; `turn.completed` clears running and replaces the streamed assistant text with `payload.response` when present; ignore events of other sessions; show an error item when a failed turn carries an error.
- `src/pairing.ts`: `parsePairingPayload(text)` for the QR JSON `{u,w,c}` (also accept `zcode://pair?...` is NOT needed); `pair(payload, deviceName)` does `POST {u}/pair` and returns `{id, token, wsUrl}`.
- `src/storage.ts`: save and load `{wsUrl, token, deviceId}` with expo-secure-store. Wrap every call in try/catch.
- `src/useRelay.tsx`: React context that owns one `RelayClient`, exposes status, servers list, `rpc`, and a subscription hook `useSessionEvents(sessionId)`.
- `app/_layout.tsx`, `app/index.tsx` (redirect to `/pair` when no credentials, else `/sessions`), `app/pair.tsx` (camera QR scan with `CameraView`, plus a text box to paste the pairing JSON; show errors), `app/sessions.tsx` (FlatList of sessions from `session/list`: title, workspace folder name, status, relative time; pull to refresh; button "New session"; header shows connection status; menu item "Unpair"), `app/new.tsx` (choose workspace from `servers`, mode `plan` or `edit` only, create with `session/create` using model `{providerId:"account:zai-individual-coding-plan", modelId:"GLM-5.3-Flash", options:{reasoningLevel:"max"}}`, then `session/subscribe` with `deliveryKind:"web-remote-replayable"`), `app/session/[id].tsx` (chat screen: resume with `session/resume`, subscribe, render reducer items; streaming text; collapsible tool cards; reasoning in a collapsed block; input box and Send button sending `session/send` with `modelSelection`; Stop button while running calling `session/stop`; banner when status is `reconnecting`; read-only notice when an event shows a permission request).
- `__tests__/reducer.test.ts` (uses `fixtures/events-sample.jsonl`), `__tests__/pairing.test.ts`, `__tests__/client.test.ts` (mock WebSocket: auth first, rpc match, reconnect sends `since`, duplicate events dropped, 4003 stops).
- `README.md`: how to run (`npm install`, `npx expo start`, iOS simulator), how to pair (`node relay.mjs pair`), and the cleartext note.

## Rules
- Never offer `yolo` or `build` modes. Only `plan` and `edit`.
- Never log the token. Never put the token in a URL.
- Use only the relay methods listed in RELAY_PROTOCOL.md.
- `session/messages` (history) has an unknown response shape. Call it with `{sessionId, limit:50}`, render what you can, and ignore it if parsing fails. Do not crash.
- Keep components small. Light and dark themes through `useColorScheme`. 16 px side padding.
- Short comments only where the code is not obvious.

## Finish
Write `STATUS.md` in the current directory: files created, what is done, what you are unsure about. Then reply with the single line: `phase 1 done`.
