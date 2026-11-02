# Work order 21: remember answers to ZCode questions

You write code. Claude Code supervises and runs every command (install, type check, tests, the app). You cannot run commands or delete files: every shell command is refused, so do not try. If a step needs a command, skip it and say in your reply what you could not check.
Edit only inside the current directory. Do not commit. Do not add secrets, analytics, or network calls.

## Read first
- `mac/lib/sessions.mjs` (`questionsOf`, `answerResult`, `respondQuestion`, `listPending`, `pendingToAutoAllow`, `AUTO_ALLOW_RESULT`)
- `mac/main.mjs` (`actions.answerQuestion`, the poll loop that already auto-allows permissions, `save()`/`refresh()`/`pushPanel`, the panel action handler, how settings are stored)
- `mac/lib/settings.mjs`, `mac/lib/panel.mjs` (settings payload), `mac/panel/index.html` + `panel.js` (Settings sheet switches, `setSwitch`, `flip`)
- `relay/service.mjs` around the `interaction/requestUserInput` handling (search `requestUserInput` and `tap/respond`): the phone answers questions through the relay, not the Mac panel.

## Goal
When the user answers a ZCode question once (from the Mac panel or from the phone), Zode remembers the answer. If an identical question appears again and the setting "Remember answers" is on, Zode answers it automatically with the remembered answer, so the user is never asked the same thing twice. A "Forget answers" action empties the memory.

## Design (use exactly this; follow the user's UI rule: no secondary labels, descriptions or hint text; the layout explains)
- New pure module `mac/lib/decisions.mjs`:
  - `keyOf(question)`: stable key from the question text (trimmed, lowercased, whitespace collapsed) plus its sorted option labels. Free-text questions (no options) are never remembered: `keyOf` returns null.
  - `createDecisions({ file, now = Date.now, cap = 200 })` returns `{ remember(question, answer), lookup(question), forget(), size() }`. `answer` is a label, a label array (multiSelect) or a string. Persist as JSON in `file` (atomic write via temp file + rename, mode 0600), newest-first, capped at `cap`. Corrupt or missing file means empty.
  - `lookup(question)` returns the remembered answer only if every remembered label is still among the question's current option labels; otherwise null.
- Setting `rememberAnswers` (boolean, default false) in `mac/lib/settings.mjs`, passed to the panel in `mac/lib/panel.mjs`. Panel: one `.set` row "Remember answers" with the same switch style as the other switches, and one row "Forget answers" (button style like other action rows) shown only while at least one answer is stored (send `size` in the panel settings payload). No other text.
- `mac/main.mjs`: create the store in the Zode state directory (`decisions.json`, next to the other state files; use the same dir helper the app already uses). On `actions.answerQuestion`, call `remember` for single question entries that have options. In the pending poll, when `rememberAnswers` is on and a pending question entry has exactly one question and `lookup` returns an answer, answer it with `answerResult` + `respondQuestion` and do not show it as a need card. A question with more than one question block is never auto-answered. New panel actions `toggleRememberAnswers` and `forgetAnswers` (validate like the other toggles).
- Phone answers: in `relay/service.mjs` add an optional option `onQuestionAnswered({ params, result })` called when the phone responds to an `interaction/requestUserInput` (use the existing pending-request map to get the original params). Wire it in `mac/main.mjs` to `remember`. If the relay cannot see the original params at that moment, say so in your reply and skip this part; do not invent a protocol.
- Auto-answered questions are logged with `log.log` as `auto-answered question: <header or first 40 chars>` (no answer text, no secrets).

## Tests (node:test, the existing style)
- `mac/test/decisions.test.mjs`: keyOf normalisation and option-order independence, free-text returns null, remember/lookup round trip, stale label returns null, cap, corrupt file, `forget`, persistence across two `createDecisions` instances.
- extend the existing sessions/panel/settings tests: `rememberAnswers` default false, in the panel payload, toggle action accepted and junk ignored.
- relay test: `onQuestionAnswered` fires once with the original params and the result.

## Rules
- Do not change defaults of other settings, the permission/approval flow, the protocol the phone speaks, or the phone app.
- No new dependencies. Keep files small; short comments only where not obvious.

## Quality bar
Claude runs `npm test --prefix mac` and `npm test --prefix relay`, and the panel in a browser: switch works, "Forget answers" appears only when something is stored, no auto-answer when the setting is off, no auto-answer for multi-question or free-text questions, long question text does not overflow, dark mode.

Reply with the single line: `decisions done`.
