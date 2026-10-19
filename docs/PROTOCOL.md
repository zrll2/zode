# Protocol notes

Zode talks to ZCode through interfaces that ZCode does not document. This page records what we observed. It was checked against **ZCode 3.15.3 (agent 0.16.9)** and can change in any release. If something breaks after an update, start here.

## 1. ZCode agent (stdio)

Start: `ELECTRON_RUN_AS_NODE=1 <ZCode binary> glm/zcode.cjs app-server --stdio --cwd <dir> [--surface desktop]`.
One JSON object per line. Requests are `{id, method, params}`; replies are `{id, result}` or `{id, error}`. **Do not send a `jsonrpc` key**: the agent rejects it.

Client to agent: `session/create`, `resume`, `list`, `read`, `messages`, `events`, `subscribe`, `send`, `stop`, `close`, `fork`, `compact`, `goal`, `setModel`, `setThoughtLevel`, `setMode`, `usage`, plus `provider/*`, `workspace/*`, `tasks/*`.

| Call | Params |
|---|---|
| `session/create` | `{workspace:{workspacePath, workspaceKey}, model?, mode?}` |
| `session/resume` | `{sessionId}` (the reply includes the whole message list) |
| `session/subscribe` | `{sessionId, deliveryKind:"desktop-continuous"\|"web-remote-replayable"}` |
| `session/send` | `{sessionId, content:string, modelSelection?}` (the key is `content`) |
| `session/messages` | `{sessionId, limit}` returns `{messages:[{info:{id,role,time,semantics?}, parts:[...]}]}` |
| `session/stop`, `session/close` | `{sessionId}` |

`model` and `modelSelection` look like `{providerId, modelId, options:{reasoningLevel}}`. A reasoning level is required.

Message parts: `text`, `reasoning`, `tool` (`tool`, `callID`, `state:{status,input,output}`), `step-start`, `step-finish`, `timeline`. A message whose `info.semantics.uiVisibility` is `"hidden"` is injected by the runtime (todo reminders, background-task notices). ZCode's own window hides these; so should clients.

Agent to client **requests** (the window must answer, or the agent waits):

| Method | Reply |
|---|---|
| `session/requestRuntimePreferences` | `{nativeSearchEnhancementsEnabled:boolean, memoryEnabled?, askUserQuestionAutoResolutionEnabled?, modelContextBudgetStrategy?}` |
| `interaction/requestPermission` | `{decision:"allow"\|"deny"\|"escalate"\|"modify", reason?}` |
| `interaction/requestUserInput`, `interaction/requestProviderRuntimeHeaders`, ... | not used by Zode |

Request params for permission: `{sessionId, toolName, toolCallId, turnId, requestId, input, reason, riskLevel, options}`.

Agent to client **events** arrive as notifications. Session events are `{method:"session/event", params:{type, payload, seq, sessionId, turnId}}` with types such as `turn.started`, `model.streaming` (`payload.kind`: `text_delta`, `reasoning_delta`, ...), `tool.updated`, `turn.completed` (`payload.response` is the final text), `session.updated`. Status changes: `{method:"state.updated", params:{patch:{status:"running"|"idle"|...}}}`.

## 2. Tap socket (Zode wrapper)

Unix socket at `~/.zcode-tap/<pid>.sock` (a short path under `/tmp` if the home path is long). Metadata in `<pid>.json`. Same line format as above, with these rules:

- Clients may only send requests (`{id, method, params}`).
- A reply to your request carries `"tapReply": true`. Anything without it is a copy of traffic meant for the ZCode window; ignore replies, observe notifications and requests.
- `tap/pending` returns open permission and user-input requests.
- `tap/respond` with `{id, result}` answers one of them. The first answer from any source wins.
- `tap/resolved` (notification) `{id, by}` tells everyone a request was answered.

## 3. Relay (WebSocket, JSON text frames)

See [`relay/README.md`](../relay/README.md) for the full table. In short: pair with `POST /pair {code, name}`, authenticate with `{type:"auth", token, since?}`, call `{type:"rpc", id, method, params, server?}`, receive `rpc-result`, `event` frames (with a `seq` for replay), and answer approvals with `{type:"respond", rid, server, id, decision}` (allow or deny only).
