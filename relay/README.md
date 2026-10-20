# zcode-relay

WebSocket gateway on the Mac. It lets a phone use the ZCode sessions of the running **Zode.app** (see `../zcode-mcp`).

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
The relay has no TLS. Do not bind it to `0.0.0.0` on an untrusted network. Do not forward the port on your router.

## Module API

Zode.app runs the relay inside its own process; the CLI above is a thin wrapper over it.

```js
import { createRelay } from './relay/service.mjs';

const relay = createRelay({ host, port, publicUrl, stateDir, tapDir, log });
await relay.start();            // -> {host, port}; rejects with the listen error (.code 'EADDRINUSE', ...)
await relay.stop();             // closes the http server, websockets, upstream sockets and timers; safe to call twice
relay.status();                 // {running, host, port, publicUrl, upstreams, clients, devices}
relay.createPairing();          // -> {code, expiresAt, publicUrl, payload}; payload is the QR text, override publicUrl per call
relay.listDevices();            // -> [{id, name, pairedAt}]
relay.revokeDevice(id);         // -> boolean; also closes that phone's live websocket
relay.on('status', fn);         // emitted when status() changes, at most one per 250 ms (relay.off to unsubscribe)
```

Every option is optional: `host` 127.0.0.1, `port` 8787, `publicUrl` `ws://host:port`, `stateDir` `~/.zode/relay`, `tapDir` `~/.zcode-tap`, `log` `console`, `codeTtlMs` 5 minutes (pairing-code lifetime). All state is per instance: two relays with different ports and state dirs can run in one process. `checkPolicy(method, params)` is also exported for callers that want the allow-list themselves. Run the tests with `npm test` in this directory.

## Protocol (JSON text frames)

| Direction | Frame |
|---|---|
| phone to relay (HTTP) | `POST /pair {code, name}` returns `{id, token}` |
| phone to relay | `{type:"auth", token, since?}` must be the first frame (10 s limit) |
| relay to phone | `{type:"ready", device, servers:[{pid,cwd}], seq}` |
| phone to relay | `{type:"rpc", id, method, params, server?}` |
| relay to phone | `{type:"rpc-result", id, result|error}` |
| relay to phone | `{type:"event", seq, server, msg}` (ring buffer of 5000; reconnect with `since`) |
| phone to relay | `{type:"servers"}`, `{type:"resume", since}` |

## Rules the relay enforces

- Only these methods: `session/{list,create,resume,read,messages,events,subscribe,send,stop,close,setModel,setThoughtLevel,setMode,usage,goal,compact,rename}`, `usage/stats` and `attachment/upload`.
- `session/create` needs `mode` = `plan`, `edit` or `guarded`. `yolo` and `build` are refused.
- `session/delete` was removed: the agent accepts a `deleteSession` command but it only closes the session in memory — the record stays — so the relay no longer offers it and a phone gets `method not allowed`.
- `session/rename` renames one through the agent's `v4/command` envelope (`renameSession`, sent after a `session/resume` so the session is active); the id must be a `sess_` id of at most 100 characters, and the title must trim to 1-120 characters (the trimmed title is sent).
- `attachment/upload` resumes the session, stages the file with the agent in chunks of at most 256 KiB and answers `{ref, fileName, mime, bytes}`: files up to 8 MB, `fileName` up to 200 characters (the relay replaces `/`, `\` and control characters with `_`), `mime` a lowercase `type/subtype`.
- `session/send` accepts up to 6 `attachments` (`{ref, fileName, mime, bytes}` whose `ref` points into the same session) and sends them as the agent's `sendText` command; without attachments it is forwarded unchanged.
- `usage/stats` is a plain read, forwarded unchanged; `range` must be exactly `all`, `7d` or `30d`.
- Every `v4/command` envelope is built by the relay itself; a phone can never send `v4/command` or inject fields into it.
- Tokens are stored as SHA-256 hashes in `~/.zode/relay/devices.json` (mode 0600). Pair codes work once and expire.
- Five failed attempts from one address cause a 60 second block.

## Known limits

- Permission requests (`guarded` mode) go to the desktop window only. The phone sees them as events but cannot answer. Use `edit` mode until a claim step is added to the wrapper.
- Turn end: watch for a `session/event` whose `payload.response` is set. Telemetry events are filtered out.
- The relay needs Zode.app running. Without it, `rpc` returns `no ZCode server`.
