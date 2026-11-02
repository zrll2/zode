# Work order 25: the relay accepts question answers from the phone

You write code. Claude Code supervises and runs every command (install, type check, tests, the app). You cannot run commands or delete files: every shell command is refused, so do not try. If a step needs a command, skip it and say in your reply what you could not check.
Edit only inside the current directory. Do not commit. Do not add secrets, analytics, or network calls.

## Read first
- `relay/service.mjs`: the `m.type === 'respond'` handler (~line 737), `pendingReq` (what a pending entry holds: `method`, `params`), the `ready` frame (`features: { stt, push }`), `PROTOCOL`, the `onQuestionAnswered`-style option hooks already passed in `createRelay(opts)`
- `mac/lib/sessions.mjs`: `questionsOf(params)` and `answerResult(questions, picks)` (the exact answer shape ZCode accepts) and `mac/main.mjs` `rememberPick` / `decisions` (the memory added by the previous order)
- `relay/test/service.test.mjs` (how respond is tested), `relay/README.md` (protocol doc)

## Goal
A paired phone can answer a ZCode question (`interaction/requestUserInput`) through the relay, and the answer is remembered by the Mac's decision memory.

## Verified facts (use exactly these)
- ZCode accepts, via `tap/respond`: `result: { action: 'accept', content: { answers: { [questionText]: label | label[] } } }`, or `{ action: 'decline' }`.
- Today `respond` fails with `only permission requests can be answered from mobile` for anything but `interaction/requestPermission`.
- Pending question params shape: `{ questions: [{ header, question, multiSelect, options: [{ label, description }] }], ... }`.

## Design
- Protocol (additive, a new feature flag, no PROTOCOL bump): `ready.features.answers = true`. A phone sends `{ type: 'respond', rid, server, id, answers: { [questionText]: label | label[] } }` or `{ type: 'respond', rid, server, id, decision: 'decline' }` for a pending `interaction/requestUserInput`. Permission requests keep working exactly as before.
- Validation (reject with the existing `-32011` error shape and a short message): the request must still be pending; `answers` must be a plain object with one entry per question (at most 4 questions); every key must be one of the pending question texts; a value must be a string equal to one of that question's option labels, or (only when that question has `multiSelect: true`) a non-empty array of distinct option labels (at most 8). Free-text answers are not accepted in this order.
- Build the result in the relay with a tiny local helper (the relay package must not import from `mac/`), same shape as `answerResult`. Write it with `tap/respond` the same way the permission branch does (route, error handling when the socket is dead).
- Audit: an answer is not an approval; write no audit row. Log `answer <device> -> <server>` without the answer text.
- New option `onQuestionAnswered({ params, answers })` in `createRelay(opts)`, called once after a successful write, with the pending params and the accepted `answers`. Wire it in `mac/main.mjs` to the existing remember logic (`rememberPick(questions, answers)` accepts the same `{ [question]: pick }` shape; reuse it, do not duplicate). A throwing hook must never break the response.
- `relay/README.md`: document the new frame and the flag in a few lines.

## Tests
- relay tests: accept single, multi, decline; reject unknown question key, unknown label, array on a single-select question, empty array, more than 4 questions, not pending, permission request still needs `decision`; `features.answers` is true in `ready`; `onQuestionAnswered` fires once with params and answers and a throwing hook is swallowed; dead socket path; no audit row for answers.
- a main test that a relayed answer reaches `decisions` (if main.test.mjs has a seam; otherwise skip and say so).

## Rules
- Do not change the permission path, the phone app, or any default. No new dependencies. Keep changes small.

## Quality bar
Claude runs `npm test --prefix relay` and `npm test --prefix mac`. Edge cases: the same answer sent twice (second one fails as not pending), a question with zero options (rejected), very long label strings (capped by existing frame limits).

Reply with the single line: `relay answers done`.
