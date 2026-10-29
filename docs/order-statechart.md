# Work order 17: approval lifecycle statechart and model-based tests

You write code. Claude Code supervises and runs every command. You cannot run commands or delete files; skip any step that needs one and say so.
Edit only inside the current directory. Do not commit. No new dependencies (no XState), no network, no secrets.

## Read first
`relay/audit.mjs`, `relay/service.mjs` (`autoAllowRequest`, the `respond` branch, `pendingReq`, `auditAsk`, the reconcile/`tap/resolved` drop path), `relay/test/audit.test.mjs`, `relay/test/service.test.mjs`.

## Goal
One small pure module `relay/lifecycle.mjs` that is the single written-down model of a permission request's life, used by (a) model-based tests and (b) an optional runtime trap in the audit log.

## Design (use exactly this)
```js
export const STATES = ['pending', 'allowed', 'rejected', 'cancelled', 'unavailable'];   // last four are terminal
export const EVENTS = ['asked', 'auto_allow_ok', 'auto_allow_failed', 'phone_allow', 'phone_deny',
  'phone_write_failed', 'panel_allow', 'panel_deny', 'panel_write_failed', 'vanished'];
export const TABLE = { pending: { asked: 'pending', auto_allow_ok: 'allowed', auto_allow_failed: 'unavailable', ... }, ... };
export function step(state, event) -> { state, legal: boolean }   // a terminal state ignores every event (legal:false, state unchanged); unknown event/state -> legal:false, state unchanged
export function outcomeOf(state) -> 'pending' | OUTCOME string  // same names as audit OUTCOMES
export function paths(maxLen = 4) -> array of event sequences      // every sequence from `pending`, depth-first, used by tests
```
Mapping to the existing audit semantics: auto_allow_ok -> allowed (by auto); phone_allow/panel_allow -> allowed; phone_deny/panel_deny -> rejected; *_write_failed and auto_allow_failed -> unavailable (NEVER allowed); vanished -> cancelled. A repeated `asked` stays pending.

- `createAuditLog` in `relay/audit.mjs`: accept optional `onIllegal({id, state, event})` option. When `decided` arrives for an id already decided (the existing first-wins rule) call `onIllegal` once, still ignoring the write. Default is a no-op. Do not change any other behaviour or file format.
- `relay/service.mjs`: pass `onIllegal` that calls the relay's existing `log` with one line `lifecycle: illegal ${event} for ${id} in ${state}` (sparse: at most 1 per request id). Keep every existing test passing.

## Tests (node:test, `relay/test/lifecycle.test.mjs`)
- Table is total and closed: every STATE x EVENT maps to a state in STATES; terminals never change.
- Model-based: for every sequence from `paths(4)`, replay it through a real `createAuditLog` (temp file) using a small adapter that turns events into `asked`/`decided` calls (write_failed -> decided unavailable/none), and assert `recent()[0].outcome === outcomeOf(finalState)` and exactly one decided row exists for the id in the file after any number of events.
- Safety invariants over all paths: a sequence containing a `*_failed` event before any allow event never ends `allowed`; no path ends `allowed` without an allow event.
- `onIllegal` fires once for a second `decided`, never for the first.

## Rules
Do not change defaults, protocol messages, panel, mac app or phone app. Short comments only where not obvious. Match file style.
Reply with the single line: `lifecycle done`.
