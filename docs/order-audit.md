# Work order 14: approval audit log

You write code. Claude Code supervises and runs every command (install, type check, tests, the app). You cannot run commands or delete files: every shell command is refused, so do not try. If a step needs a command, skip it and say in your reply what you could not check.
Edit only inside the current directory. Do not commit. Do not add secrets, analytics, or network calls.

## Read first
- `relay/service.mjs` (`autoAllowRequest` ~line 232, the `respond` branch ~line 615, `pendingReq`, `upstream`, `log`)
- `relay/risk.mjs` (`isRiskyRequest`)
- `mac/main.mjs` (the non-relay auto-allow block ~line 431, `actions.approve/deny/approveMany/denyMany/alwaysAllow` ~lines 778-860 and ~1079-1105, `appendLog`, `settingsFile`/home dir handling, `refreshSessions`)
- `mac/lib/settings.mjs` (how a small file in `~/.zode/` is written atomically, mode 0600)
- `mac/preload.cjs` and `mac/panel/panel.js` top (how the panel gets data and calls actions)

## Goal
Every permission request ZCode raises is recorded locally as a pair of facts, and every answer comes from a named source. If nothing can answer (socket gone), the outcome is `unavailable` and the request is NOT allowed. A later order adds the panel UI; this order delivers the log, the wiring and a read API.

## Design (use exactly this)
New file `relay/audit.mjs`, pure Node, no deps:
```js
export const OUTCOMES = ['allowed', 'rejected', 'cancelled', 'unavailable'];
export const ANSWERERS = ['auto', 'phone', 'panel', 'none'];
export function createAuditLog({ file, now = Date.now, maxLines = 2000 }) -> {
  asked({ id, tool, summary, risky, sessionId })   // id = `${pid or sock}:${requestId}` string, unique per request
  decided({ id, outcome, by, device })             // outcome in OUTCOMES, by in ANSWERERS, device optional short name
  recent(limit = 50) -> [{ id, at, tool, summary, risky, outcome, by, device, askedAt }]  // newest first, one row per id; an asked row with no decided row yields outcome 'pending'
}
```
- File is JSON Lines at `file` (callers pass `~/.zode/approvals.jsonl`), created mode 0600, directory created if missing. Each line: `{ "e": "asked"|"decided", "id", "at", ... }`.
- `summary` is trimmed to 160 chars, whitespace collapsed, never longer. `tool` trimmed to 60 chars. No tool arguments beyond that summary are stored.
- A second `asked` for the same id, or a second `decided` for the same id, is ignored (first wins), tracked with an in-memory Set that is rebuilt from the file lazily on first call.
- When the file exceeds `maxLines` lines, rewrite it to the newest `maxLines / 2` lines atomically (temp file + rename). Check the line count cheaply (keep a counter; count lines once at first use).
- Every method never throws: errors are swallowed (a full disk must not break approvals). Unknown outcome/by values are coerced to `'unavailable'` / `'none'`.

## Wiring
1. `relay/service.mjs`: accept `opts.audit` (an audit log; optional). When absent, do nothing extra.
   - Where a permission request is first stored in `pendingReq` (both places that call `autoAllowRequest`), call `audit.asked(...)` once per request (tool = `params.toolName`, summary = the existing command/summary text the relay already derives for push or risk check; if none, tool name; risky = `isRiskyRequest(params)`).
   - `autoAllowRequest`: after a successful write call `decided({outcome:'allowed', by:'auto'})`. If the socket write throws, call `decided({outcome:'unavailable', by:'none'})` and leave the request pending as today.
   - `respond` branch: on a successful write record `decided` with outcome `allowed` for `allow`, `rejected` for `deny`, `by:'phone'`, device = `c.device.name` if present. On the dead-socket catch record `unavailable`/`none`.
   - When a request disappears without an answer (the reconcile drop and any `tap/resolved` that arrives for a request this relay did not answer), record `cancelled`/`none` unless a decision already exists for it. Do not double-record when the relay itself answered.
2. `mac/main.mjs`: create one audit log at `path.join(zodeHome, 'approvals.jsonl')` (use the same home-dir variable the settings file uses), pass it to `createRelay({... audit })`, and:
   - the non-relay auto-allow block records asked+decided (`allowed`, `auto`) per request, and `unavailable` when the respond call throws;
   - `approve`/`approveMany`/`alwaysAllow` record `allowed` by `panel`; `deny`/`denyMany` record `rejected` by `panel`; a failed respond records `unavailable`. Record `asked` for any request you answer that has no asked row yet (the log ignores duplicates).
3. Read API: in `mac/main.mjs` add an IPC/handler `approvalLog` returning `audit.recent(30)` to the panel, using the same mechanism the panel already uses for other reads. Add the channel to `mac/preload.cjs` allow-list. Do NOT change the panel HTML, CSS or JS in this order.

## Tests (node:test, in the existing test folders)
- `relay/test/audit.test.mjs`: pair merge, pending without decision, duplicate asked/decided ignored, summary trimming and whitespace, unknown outcome coerced, truncation past maxLines keeps newest, file mode 0600, unwritable path does not throw, recent order and limit.
- Add to the relay service test file (find the existing auto-allow tests) cases: auto-allow records allowed/auto; phone respond records allowed/rejected with device; dead socket records unavailable and the request stays pending; vanished request records cancelled once.
- `mac/test/`: a small test that main.mjs wires `approvalLog` (follow the existing main.test.mjs style) and that the preload allow-list contains it.

## Rules
- Do not change protocol messages sent to phones, `risk.mjs`, defaults of auto-allow or askRisky, or any panel file.
- A missing `opts.audit` must keep every existing behaviour and test unchanged.
- Short comments only where not obvious. Match the style of the surrounding files.

## Quality bar
Claude runs `node --test` for relay and mac and checks: no throw paths, no double records, nothing but the 160-char summary is stored, the unavailable path never allows anything.

Reply with the single line: `audit done`.
