Claude ran the app in the iOS simulator against the real relay. Pairing works and the session list loads. These defects remain. The cause of most is that the protocol doc did not give exact RPC parameters. Verified shapes are below. Fix all items, update tests, and keep tsc and jest clean (you cannot run them; Claude will).

## Verified RPC shapes (checked against the real server)
- `session/list` params `{}` -> `result.sessions[]` items: `{sessionId, title, titleSource, status ("idle"|"running"|...), mode, createdAt (ms), updatedAt (ms), workspace:{workspacePath, workspaceKey}, sessionKind}`.
- `session/create` params `{workspace:{workspacePath, workspaceKey}, model:{providerId, modelId, options:{reasoningLevel}}, mode:"plan"|"edit"}` -> `result.session.sessionId`.
- `session/resume` params `{sessionId}`. `session/subscribe` params `{sessionId, deliveryKind:"web-remote-replayable"}`.
- `session/send` params `{sessionId, content: string, modelSelection:{providerId, modelId, options:{reasoningLevel}}}`. The key is `content`. It is NOT `text`. Any other key is rejected ("Unrecognized key").
- `session/stop` params `{sessionId}`. `session/close` params `{sessionId}`.
- `session/messages` params `{sessionId, limit}` -> `result.messages[]`, each `{info:{id, role:"user"|"assistant", time:{created, completed?}}, parts:[...]}`. Part types: `text` (`text`), `reasoning` (`text`), `tool` (`tool` name, `callID`, `state:{status, input, output}`), `step-start`, `step-finish`, `timeline`. Render `text`, `reasoning` (collapsed) and `tool` (collapsed card). Skip `step-start`, `step-finish`, `timeline`. A user message can contain very long injected text: show at most 600 characters and a "Show more" toggle.

## Defects to fix
1. Sending a message fails with `Invalid params - content: expected string ... Unrecognized key "text"`. Use `content` (see above). Add a test that asserts the exact `session/send` params.
2. The session list shows "No workspace" for every session. Show the last path segment of `workspace.workspacePath`.
3. The chat screen title is always "Session". Pass the session title from the list through the route params and show it. Fall back to "Session".
4. Chat history is empty ("No messages yet"). Load `session/messages` with limit 50 using the shape above, convert to chat items, and show them above live events. Avoid duplicates when live events replay the same turn (match by message id or by turn).
5. Check `app/new.tsx` and every other RPC call in `src/` against the verified shapes. Fix any mismatch.
6. Update `RELAY_PROTOCOL.md`: add a section "RPC parameter shapes" with the verified shapes above.

Reply with the single line: `sim fixes done`.
