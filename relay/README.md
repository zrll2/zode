# zcode-relay

WebSocket gateway on the Mac. It lets a phone use the ZCode sessions of the running agent on your Mac — the **Zode for Mac** menu bar app (`../mac`) runs it. (`zcode-mcp` was this project's old name.)

```
phone (Expo app) --ws--> zcode-relay --unix socket--> agent-wrapper (inside Zode.app) --stdio--> zcode app-server
```

## Run

```bash
node relay.mjs serve        # RELAY_HOST (default 127.0.0.1), RELAY_PORT (default 8787)
node relay.mjs pair         # prints a QR code and a one-time code (5 minutes)
node relay.mjs devices      # list paired phones
node relay.mjs revoke <id>  # remove a phone
```

Set `RELAY_HOST` to the Tailscale or WireGuard address of this Mac. Set `RELAY_PUBLIC_URL` to the URL the phone uses (for example `ws://100.x.y.z:8787`).
The relay never binds `0.0.0.0`, and it binds `127.0.0.1` only when that is the only host. The relay has no TLS: a Wi-Fi/LAN address is unencrypted, a Tailscale address is not. Do not forward the port on your router.

## Module API

The Zode for Mac menu bar app (`../mac`) runs the relay in its own process, and the older patched-ZCode integration (`../macapp`) ran it inside the app; the CLI above is a thin wrapper over the same service.

```js
import { createRelay } from './relay/service.mjs';

const relay = createRelay({ hosts, port, publicUrls, stateDir, tapDir, log, stt });
await relay.start();            // -> {host, port}; listens on EVERY host; rejects with the first listen error (.code 'EADDRINUSE', ...) and closes the rest
await relay.stop();             // closes every http listener, websockets, upstream sockets and timers; safe to call twice
relay.status();                 // {running, host, hosts, port, publicUrl, publicUrls, upstreams, clients, devices}
relay.createPairing();          // -> {code, expiresAt, publicUrl, publicUrls, payload}; payload is the QR text, override publicUrl per call
relay.listDevices();            // -> [{id, name, pairedAt}]
relay.revokeDevice(id);         // -> boolean; also closes that phone's live websocket
relay.on('status', fn);         // emitted when status() changes, at most one per 250 ms (relay.off to unsubscribe)
```

Every option is optional: `hosts` `['127.0.0.1']` (one http listener per host on the same port; `host` works as a one-element list), `port` 8787, `publicUrls` `ws://<host>:<port>` for each host (`publicUrl` is kept as the first one for compatibility), `stateDir` `~/.zode/relay`, `tapDir` `~/.zcode-tap`, `log` `console`, `codeTtlMs` 5 minutes (pairing-code lifetime), `autoAllow` `() => false` (when the callback returns true, every `interaction/requestPermission` is answered `allow` — "Approved automatically by Zode" — the moment the relay knows about it, and never offered to phones as pending; `interaction/requestUserInput` questions are never answered), `askRisky` `() => false` (only matters with `autoAllow` on: when it returns true, requests the shared classifier in `relay/risk.mjs` calls risky — high risk plus destructive commands, and `rm -rf` / `sudo ` / `git push --force` whatever the agent thinks — stay pending for a human), `stt` the host's speech engine (see the section below; without it the voice methods answer `voice-off`). All state is per instance: two relays with different ports and state dirs can run in one process. `checkPolicy(method, params)` is also exported for callers that want the allow-list themselves. Run the tests with `npm test` in this directory.

## Protocol (JSON text frames)

| Direction | Frame |
|---|---|
| phone to relay (HTTP) | `POST /pair {code, name}` returns `{id, token, pushKey}` — every listener answers it |
| phone to relay | `{type:"auth", token, since?}` must be the first frame (10 s limit) |
| relay to phone | `{type:"ready", device, servers:[{pid,cwd}], seq, pending, features:{stt, push}, addresses:[<every ws url>]}` — a paired phone learns all addresses on each connection |
| phone to relay | `{type:"rpc", id, method, params, server?}` |
| relay to phone | `{type:"rpc-result", id, result|error}` |
| relay to phone | `{type:"event", seq, server, msg}` (ring buffer of 5000; reconnect with `since`) |
| phone to relay | `{type:"servers"}`, `{type:"resume", since}` |

The pairing payload (the QR text) is `{u, urls, w, c}`: `u` is the http form of the first address and `w` its ws form (what old phones read), `urls` lists every ws address (what newer phones read).

## Push notifications (`push/register`, `push/unregister`)

Every pairing creates a **push key** for the phone: 32 bytes, base64url, in the `POST /pair` answer (`pushKey`) and in the device record (`devices.json`, mode 0600; `listDevices()` never exposes it, like the token hash). The key seals notifications for that phone. Devices paired before push existed have no key: they get no pushes until they re-pair.

Two relay-answered rpc methods over the authed connection (never forwarded upstream):

- `push/register` `{ pushId (20..2000, base64url), secret (20..200, base64url), env: 'production'|'sandbox' }` → `{ ok: true }`; stored on the device record as `push`. A phone without a push key gets the rpc error `-32021 no-push-key`.
- `push/unregister` `{}` → `{ ok: true }`.

The Mac seals each notification with the phone's push key and the relay forwards it through the push service (`push-service/`): `POST {ZODE_PUSH_URL|https://zode-push.vercel.app}/api/push` with `{ pushId, auth: secret, kind, sealed, collapseId }`. A phone that talked to this relay in the last 30 s is skipped for quiet kinds (finished, stuck) — asks, questions and failures always go out. A pending permission or question pushes about 1.5 s after it arrives, only if it is still pending then. A `gone` answer from the service clears the registration until the phone re-registers.

**Sealing format** (the phone ports `openSealed` from `relay/push.mjs`): `sealed` = base64url(`iv(12) | ciphertext | tag(16)`) of AES-256-GCM over the UTF-8 JSON `{ v: 1, kind, title, body, session?, project?, req?: { server, id }, at }`, with the kind string as AAD. The fixed test vector (the key and iv are test constants, never a real key):

- key: `AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA` (base64url of 32 zero bytes)
- iv: `[0,1,2,3,4,5,6,7,8,9,10,11]`
- kind (also the AAD): `ask`
- plaintext: `{"v":1,"kind":"ask","title":"zode-live-wt","body":"Run: npm test","req":{"server":42,"id":"req-9"},"at":1750000000000}`
- sealed: build with `crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 })`, `setAAD(kind)`, output `iv | ciphertext | tag` as base64url. `relay/test/push.test.mjs` constructs exactly this vector, and `openSealed` must return the plaintext object.

`ZODE_PUSH_URL` overrides the push service URL (`https://zode-push.vercel.app` by default; set it when you deploy your own `push-service/`).

## Rules the relay enforces

- Only these methods: `session/{list,create,resume,read,messages,events,subscribe,send,stop,close,setModel,setThoughtLevel,setMode,usage,goal,compact,rename}`, `usage/stats`, `attachment/upload`, and the voice methods below.
- `session/create` needs `mode` = `plan`, `edit` or `guarded`. `yolo` and `build` are refused.
- `session/delete` was removed: the agent accepts a `deleteSession` command but it only closes the session in memory — the record stays — so the relay no longer offers it and a phone gets `method not allowed`.
- `session/rename` renames one through the agent's `v4/command` envelope (`renameSession`, sent after a `session/resume` so the session is active); the id must be a `sess_` id of at most 100 characters, and the title must trim to 1-120 characters (the trimmed title is sent).
- `attachment/upload` resumes the session, stages the file with the agent in chunks of at most 256 KiB and answers `{ref, fileName, mime, bytes}`: files up to 8 MB, `fileName` up to 200 characters (the relay replaces `/`, `\` and control characters with `_`), `mime` a lowercase `type/subtype`.
- `session/send` accepts up to 6 `attachments` (`{ref, fileName, mime, bytes}` whose `ref` points into the same session) and sends them as the agent's `sendText` command; without attachments it is forwarded unchanged.
- `usage/stats` is a plain read, forwarded unchanged; `range` must be exactly `all`, `7d` or `30d`.
- Every `v4/command` envelope is built by the relay itself; a phone can never send `v4/command` or inject fields into it.
- Tokens are stored as SHA-256 hashes in `~/.zode/relay/devices.json` (mode 0600). Pair codes work once and expire.
- Five failed attempts from one address cause a 60 second block.

## Speech to text (`stt/transcribe`, `stt/status`)

Answered by the relay itself — never forwarded to an agent server, and no ZCode server is needed. The host (the Zode menu bar app) passes its engine (the one in `../mac/lib/stt.mjs`) to `createRelay({ stt })`:

```js
stt = {
  transcribe({ audio: Buffer, format, language, hint }),  // -> {ok, text, ms, language} | {ok: false, code, error}
  status(),                                              // -> {engine, models: {small: {state, bytes}}}
  defaultLanguage(),                                     // -> 'en' | 'zh'
}
```

- `stt/transcribe` params: `{ audio: <base64 string>, format: 'wav'|'m4a'|'caf'|'mp3'|'ogg'|'flac', language?: 'en'|'zh', hint?: { projects?: string[], titles?: string[] } }`. The result is `{ ok: true, text, ms, language }`; `language` defaults to the host's `defaultLanguage()`.
- Failures are rpc errors with code `-32020` and the reason in `data.reason`: the engine's own (`no-engine`, `no-model`, `bad-audio`, `too-long`, `timeout`, `engine-failed`, `busy`), or the relay's `bad-params`, `too-large` (audio over 3 MB decoded), `rate-limited`, `voice-off` (no engine on this host; `ready` then says `features.stt: false` and `stt/status` fails the same way).
- Base64 is decoded strictly; empty audio and unknown `format`/`language` are `bad-params`.
- Hint arrays are clamped, never refused: non-strings and blanks dropped, at most 20 strings of at most 60 characters each.
- At most one transcription in flight per paired device, and at most 20 per device per minute; beyond that the answer is an immediate `rate-limited`.
- `stt/status` takes `{}` and answers `{ available, language, model: 'small', modelState: 'missing'|'partial'|'ready' }`.
- The transcript and the audio are never logged; each attempt logs one line with the device id, bytes, language, ms and ok.

## Known limits

- Permission **questions** (`interaction/requestUserInput`) go to the desktop window only. Permission requests (`guarded` mode) can be answered from the phone with `{type:"respond"}`; a typed question cannot.
- Turn end: watch for a `session/event` whose `payload.response` is set. Telemetry events are filtered out.
- The relay needs a live ZCode server (a running Engine or Zode copy with a project open). Without one, `rpc` returns `no ZCode server`.
