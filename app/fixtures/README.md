# Recorded relay events

`events-sample.jsonl`: real `msg` objects from the relay `event` stream (up to 2 per kind). Long strings are cut to 300 characters; arrays to 4 items.
Recorded turn: "create a.txt, read it back, reply verified".

Shape of a session event: `{method:"session/event", params:{type, payload, seq, sessionId, turnId, timestamp, deliveryKind}}`.

| `params.type` | `payload` fields that matter |
|---|---|
| `turn.started` | `turnNumber`, `input` |
| `model.streaming` | `kind` (for example `text_delta`, `reasoning_delta`), `delta`, `done`, `assistantMessageId` |
| `tool.updated` | `kind` (`scheduled`, `started`, `result`, ...), `toolCallId`, `toolName` |
| `checkpoint.created` | `fileCount`, `checkpointId` |
| `turn.completed` | `response` (final assistant text), `usage`, `duration`, `resultType`. This ends the turn. |
| `session.titleUpdated` | `title` |
| `session.updated` | `modelSelection`, `effectiveReasoningLevel` |

Status changes: `{method:"state.updated", params:{patch:{status:"running"|"idle"}}}`.
A failed turn shows an error object in a session event (message such as "Reasoning level is required ..."). Show it to the user.
