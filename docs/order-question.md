# Work order 16: show and answer ZCode questions in the Mac panel

You write code. Claude Code supervises and runs every command. You cannot run commands or delete files; skip any step that needs one and say so in your reply.
Edit only inside the current directory. Do not commit. No secrets, analytics, new network calls, new dependencies.

## Verified facts (do not guess)
- A ZCode question arrives in `tap/pending` as `{id, method:'interaction/requestUserInput', params:{sessionId, prompt?, toolName, questions:[{header, question, multiSelect, options:[{label, description}]}], schema:{interaction?}}}`. A plan approval has `schema.interaction === 'plan_approval'` and one question; treat it like any question.
- Answer by `tap/respond` with `result: {action:'accept', content:{answers:{[questionText]: label}}}`. For `multiSelect` the value is an array of labels. Free text: `content:{answer: text}` (single question only). Decline: `result:{action:'decline'}`.

## Read first
`mac/lib/sessions.mjs` (the `interaction/requestUserInput` branch ~line 186, `respondPermission`), `mac/lib/panel.mjs` (`kind: 'question'` ~line 105), `mac/panel/panel.js` (`needCard`, the `n.kind === 'question'` block), `mac/panel/panel.css` (`.need`, `.acts`, `.btn`, `code`), `mac/main.mjs` (panel action handler ~line 1100-1145, `actions.approve`, `idOk`, `liveSocks`), `mac/preload.cjs`.

## Goal
The orange "question" card shows what ZCode asks and lets the user answer it, with no secondary labels or hint text (layout explains).

## Design
1. `sessions.mjs`: for a question, keep `questions` (max 4, each `{question (<=300 chars), header (<=40), multiSelect:boolean, options:[{label (<=80), description (<=160)}] (max 8)}`, sanitized, junk dropped) via a pure exported `questionsOf(params)`. Add exported `respondQuestion({sock, requestId, result, ...})` (same shape as respondPermission, sends `tap/respond`). Pure exported `answerResult(questions, picks)` builds the `result` above: picks is `{[questionText]: string | string[]}`; unknown questions/labels dropped; one question and a free text pick uses `{answer}`; empty picks -> `{action:'decline'}`.
2. `panel.mjs`: question need carries `requestId`, `sock`, `questions` and `ask` = first question text (<=300).
3. `panel.js` question card: show each question text (bold, wraps), its options as buttons (single-select: click answers immediately when there is one question; with several questions or multiSelect, buttons toggle and a primary "Send" button submits, disabled until every question has a pick). Keep `Stop` and `Show in ZCode`. When `questions` is empty keep today's card. Use existing classes and CSS variables; light and dark.
4. `main.mjs`: panel action `answerQuestion` with `p.requestId` (idOk), `p.sock` (liveSocks), `p.picks` object; build with `answerResult` against the question currently pending for that request (re-list or use the cached list the other actions use); never accept a pick whose label is not one of the options. Record nothing in the audit log. `refresh()` after.
4b. Add `answerQuestion` to the preload action allow-list if actions are allow-listed.

## Tests (node:test, existing style)
`questionsOf` (sanitizing, caps, junk), `answerResult` (single, multi, free text, decline, unknown dropped), panel.mjs payload carries questions, main.mjs wiring regex test for `answerQuestion`.

## Rules
Do not touch relay, phone app, risk logic, defaults or the audit module.
Reply with the single line: `question done`.
