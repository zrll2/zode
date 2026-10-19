# STATUS — work order 01

## Files created

Config: `package.json`, `app.json`, `tsconfig.json`, `babel.config.js`, `jest.config.js`

Relay core:
- `src/relay/protocol.ts` — types for every frame in RELAY_PROTOCOL.md
- `src/relay/client.ts` — `RelayClient` (injectable socket factory, auth-first, rpc by id
  with 60 s timeout, backoff 1→30 s, reconnect with `since`, duplicate drop, 4003 →
  `authFailed` + `closed`). Also keeps a 500-event buffer that is replayed to late
  subscribers so a chat screen opened mid-turn still renders it.
- `src/relay/reducer.ts` — pure `reduce(state, event)`

App layer:
- `src/pairing.ts` — `parsePairingPayload` (`{u,w,c}`), `pair` (POST `{u}/pair`, 10 s timeout)
- `src/storage.ts` — credentials in expo-secure-store, all calls try/catch
- `src/config.ts` — `DEFAULT_MODEL_SELECTION`, `SESSION_MODES` (plan/edit only)
- `src/useRelay.tsx` — context (status, servers, rpc, connect/unpair) + `useSessionEvents`
- `src/theme.ts` (light/dark via `useColorScheme`), `src/util.ts` (basename, timeAgo,
  tolerant `session/list` parsing), `src/chatItems.tsx` (item renderers)

Screens (expo-router): `app/_layout.tsx`, `app/index.tsx` (redirect), `app/pair.tsx`
(CameraView QR + paste box), `app/sessions.tsx` (list, pull-to-refresh, status header,
unpair), `app/new.tsx` (server + mode pick, create + subscribe), `app/session/[id].tsx`
(resume/subscribe/messages, streaming, collapsible tools and reasoning, send/stop,
reconnecting + read-only permission banners).

Tests: `__tests__/client.test.ts` (auth first, rpc match/error/timeout, reconnect sends
`since`, duplicate drop, 4003 stops, late-subscriber replay), `__tests__/reducer.test.ts`
(driven by `fixtures/events-sample.jsonl` plus targeted cases), `__tests__/pairing.test.ts`.

Docs: `README.md`, this file.

## Done

- All frames are exactly the ones in RELAY_PROTOCOL.md; only the allowed relay methods are called.
- Token is never logged and never placed in a URL (only the `auth` frame carries it).
- Modes offered: `plan` and `edit` only. Cleartext `ws://` allowed on both platforms,
  explained in README.
- Reducer rules per the work order: deltas append to the streaming assistant/reasoning
  item, tool cards update by `toolCallId`, `turn.started` sets running + shows input,
  `turn.completed` clears running and replaces streamed text with `payload.response`,
  other sessions ignored, error items for failed turns, notice items for checkpoints,
  permission events set a read-only banner state.
- Strict TypeScript; no analytics; the only network I/O is the pair POST and the relay WebSocket.

## Unsure about (needs a live relay to confirm)

1. `session/create` params: I send `{cwd, mode, modelSelection}`, `modelSelection` taken
   from the field name observed in the `session.updated` fixture. The server may expect
   `model` instead, or different casing for `cwd`.
2. `server` in `rpc` frames: the only server identifier `ready` gives is `pid`, so
   `session/create`/`session/subscribe` pass the chosen server's `pid` as `server`.
3. `session/list` and `session/messages` response shapes are undocumented. Both parse
   tolerantly (array, `{sessions:…}`, `{messages:…}`, `{data:…}`; `content` as string or
   part array) and render nothing on failure. History items are shown only until the
   first live event for that session arrives, at which point the reduced live state
   replaces them (may drop older turns rendered from history).
4. The permission-request event type is unknown (`guarded` mode). Detection is
   `/permission/i` in `params.type` or a `payload.permissionRequest` object; the banner
   text may need adjusting once a real event is captured.
5. `ready.seq` is assumed to be the head of the event ring; on first connect it seeds the
   duplicate filter. If the relay replays older events on first auth (no `since`), they
   would be dropped — history covers that case.
6. Dependency versions in `package.json` are approximate per the work order;
   `npx expo install --fix` should settle them. `expo-status-bar`/`expo-constants`/
   `expo-linking` were pinned to `~58.0.0` guesses.
