# relay

WebSocket gateway on the Mac. It lets a phone use the ZCode sessions of the running **ZCode-Tap.app** (see `../bridge`).

```
phone (Expo app) --ws--> relay --unix socket--> agent-wrapper (inside ZCode-Tap) --stdio--> zcode app-server
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

## RPC parameter shapes

Verified against the real app-server. Unknown keys are rejected ("Unrecognized key").

- `session/list` params `{}` → `result.sessions[]` items: `{sessionId, title, titleSource, status ("idle"|"running"|...), mode, createdAt (ms), updatedAt (ms), workspace:{workspacePath, workspaceKey}, sessionKind}`.
- `session/create` params `{workspace:{workspacePath, workspaceKey}, model:{providerId, modelId, options:{reasoningLevel}}, mode:"plan"|"edit"}` → `result.session.sessionId`.
- `session/resume` params `{sessionId}`.
- `session/subscribe` params `{sessionId, deliveryKind:"web-remote-replayable"}`.
- `session/send` params `{sessionId, content, modelSelection:{providerId, modelId, options:{reasoningLevel}}}`. The message key is `content`, not `text`.
- `session/stop` params `{sessionId}`. `session/close` params `{sessionId}`.
- `session/messages` params `{sessionId, limit}` → `result.messages[]`, each `{info:{id, role:"user"|"assistant", time:{created, completed?}}, parts:[...]}`. Part types: `text` (`text`), `reasoning` (`text`), `tool` (`tool` name, `callID`, `state:{status, input, output}`), `step-start`, `step-finish`, `timeline`. The phone renders `text`, `reasoning` (collapsed) and `tool` (collapsed card), and skips `step-start`, `step-finish`, `timeline`.

## Rules the relay enforces

- Only these methods: `session/{list,create,resume,read,messages,events,subscribe,send,stop,close,setModel,setThoughtLevel,setMode,usage,goal,compact}`.
- `session/create` needs `mode` = `plan`, `edit` or `guarded`. `yolo` and `build` are refused.
- Tokens are stored as SHA-256 hashes in `~/.relay/devices.json` (mode 0600). Pair codes work once and expire.
- Five failed attempts from one address cause a 60 second block.

## Known limits

- Permission requests (`guarded` mode) go to the desktop window only. The phone sees them as events but cannot answer. Use `edit` mode until a claim step is added to the wrapper.
- Turn end: watch for a `session/event` whose `payload.response` is set. Telemetry events are filtered out.
- The relay needs ZCode-Tap running. Without it, `rpc` returns `no ZCode server`.
