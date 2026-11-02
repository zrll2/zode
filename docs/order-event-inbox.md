# Work order 24: wire event rules into the Mac app (drop-folder inbox)

You write code. Claude Code supervises and runs every command (install, type check, tests, the app). You cannot run commands or delete files: every shell command is refused, so do not try. If a step needs a command, skip it and say in your reply what you could not check.
Edit only inside the current directory. Do not commit. Do not add secrets, analytics, or network calls.

## Read first
- `mac/lib/triggers.mjs` and `docs/triggers.md` (the pure core, already tested: `normalizeEvent`, `parseRules`, `createLimiter`, `plan`)
- `mac/lib/bannerInbox.mjs` and `mac/test/bannerInbox.test.mjs` (the drop-folder pattern to copy: one JSON file per item in a folder under `~/.zode/`, delivered or deleted, never throws)
- `mac/main.mjs` (where `startBannerInbox` is started and stopped, `HOME`/`~/.zode` paths, `appendLog`, `settings`, `save`, `refresh`, `pushPanel`, how a session's `sock` is found for `sendToSession`, e.g. the `retry` work action near `RETRY_MESSAGE`)
- `mac/lib/sessions.mjs` (`sendToSession`, `listSessions`)
- `mac/lib/settings.mjs`, `mac/lib/panel.mjs`, `mac/panel/index.html`, `mac/panel/panel.js` (a Settings switch row)

## Goal
Anything on this Mac (a webhook forwarder, a cron job, a CI script) can wake ZCode by writing one small JSON event file into `~/.zode/events/`. Zode matches it against `~/.zode/triggers.json`, de-duplicates, rate-limits, and sends the rendered prompt to the rule's existing ZCode session. Off by default.

## Design
- `mac/lib/eventInbox.mjs`: same shape as `bannerInbox.mjs` (`parseEventFile(text, ageMs)` -> normalized event or null using `normalizeEvent`; stale drops older than 300 s are dropped; `startEventInbox({ dir, onEvent, fs, now })` returns `{ stop }`; every file is delivered or deleted; folder created with mode 0700; scan cap 50 files). Never throws.
- `mac/lib/dispatch.mjs`: `createDispatcher({ loadRules, limiter, findSession, send, log, now })` with `handle(event)`: reload rules from `loadRules()` at most every 5 s (parse with `parseRules`; log each rule error once), call `plan(...)`, then:
  - `send`: `findSession(rule.session)` returns `{ sock, sessionId }` or null (unknown or finished session: log `event skipped: session not found` and stop); call `send({ sock, sessionId, content: prompt })`; log `event <source>/<type> -> <rule name>` (no prompt text, no summary in logs).
  - `start` (rules with `new:<path>`): not supported yet; log `event skipped: new sessions are not supported yet` and stop. Do not create sessions.
  - `skip`: log reason only for `duplicate`/`rate` (once per minute per rule, to avoid log floods); `no-rule` is silent.
- `mac/main.mjs`: setting `eventRules` (boolean, default false) in `mac/lib/settings.mjs`, sent to the panel in `mac/lib/panel.mjs`. When on, start the inbox for `~/.zode/events` and route events to the dispatcher; when toggled off, stop it. Rules file: `~/.zode/triggers.json` (missing file = no rules). `findSession` uses the same session lookup the `retry` action uses. Panel: one `.set` row "Event rules" with the same switch style as the others, no other text. Toggle action `toggleEventRules`, validated like the other toggles.
- `docs/triggers.md`: add a short section "Sending an event" with a `printf` example that writes a file into `~/.zode/events/` atomically (write to a temp name outside the folder or with a `.tmp` extension, then `mv` to `*.json`).

## Tests (node:test, existing style)
- `mac/test/eventInbox.test.mjs` (mirror the banner inbox tests with an injected fake fs and clock) and `mac/test/dispatch.test.mjs` (send happy path, unknown session, new-session rule skipped, duplicate and rate skips with log throttling, rules reload and one-time error logging, send failure does not throw), plus settings/panel/main tests for `eventRules` default false, payload and toggle.

## Rules
- Never run the event text as a command or put it in a shell string. It reaches ZCode only as the rendered prompt, which already ends with the untrusted-data footer.
- No network listener, no relay changes, no new dependencies. Never change permission/approval behaviour. Keep files small; short comments only where not obvious.

## Quality bar
Claude runs `npm test --prefix mac` and drops a real event file against the running logic. Check: off by default, junk and stale files are deleted silently, nothing is logged with event text.

Reply with the single line: `event inbox done`.
