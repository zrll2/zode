# Work order 18: watch voice pipeline statechart and drift tests

You write code. Claude Code supervises and runs every command (jest, tsc). You cannot run commands or delete files; skip any step that needs one and say so.
Edit only inside the current directory. Do not commit. No new dependencies, no secrets, no network.

## Read first
- `targets/watch/PhoneLink.swift` (`VoiceStep`, `beginTranscription`, `startTranscriptTimer`, `handleTranscript`, `handleResult`, `sendPrompt`, `goHome`, `finishRecording`, `cancelRecording`, the constants at the end)
- `src/watchBridge.ts` (`handleAudioMessage`, the `file-received` handler), `src/watchVoice.ts`, `src/voice.ts` (`transcribeClip`, its rpc timeout), `__tests__/watchVoice.test.ts`
- Relay side facts: the relay answers `stt/transcribe` itself; a client-routed rpc has a 30 s relay deadline; the phone's own rpc timeout is whatever `voice.ts` uses.

## Goal
Write the watch voice pipeline down once as a pure model (a statechart), then test it model-based and test that the Swift file has not drifted from it. We had a real bug where the watch said "No answer" and nobody could tell which state or timer was responsible.

## Design (use exactly this)
New file `src/voiceMachine.ts`, pure, no React or native imports:
```ts
export const VOICE_STATES = ['idle','recording','transcribing','confirm','error','sent'] as const;
export type Path = 'message' | 'file';                    // how the clip travels while transcribing
export interface VoiceState { step: typeof VOICE_STATES[number]; path?: Path; pendingAudioId?: string; pendingPromptId?: string; awaitingSentAck?: boolean }
export const CONSTANTS = { messageTimeoutSeconds: 25, fileTransferTimeoutSeconds: 90, maxBase64Characters: 80000, minClipSeconds: 1, sentResetSeconds: 1.5 };
export type VoiceEvent = ... // startRecording, finishRecording{elapsed}, cancelRecording, beginTranscription{id, reachable, base64Chars, hasSession}, messageErrored{id}, transcript{id, ok, text?}, transcriptTimeout, confirmSend{text}, quickReply{text}, promptResult{id, ok}, sentReset, goHome, typed{text}
export function reduce(state: VoiceState, event: VoiceEvent): VoiceState   // pure; mirrors PhoneLink.swift exactly, including: ids that do not match the pending id are ignored; a timeout only acts while step is transcribing; a late transcript after timeout is ignored; messageErrored switches path message->file and restarts the timer with the file timeout; clip shorter than minClipSeconds returns to idle; no session -> error
export function timerFor(state: VoiceState): number | null           // seconds the pending timer should be set to, or null (transcribing+message -> 25, transcribing+file -> 90, sent -> 1.5, else null)
```

## Tests (jest, `__tests__/voiceMachine.test.ts`)
1. Table tests for each transition above, including every "ignored" case (stale id, timeout while not transcribing, late transcript after timeout, quick reply does not show Sent).
2. Model-based: generate event sequences of length <= 5 from a small alphabet (ids drawn from {a, b}), run `reduce`, and assert invariants after every step:
   - `transcribing` always has a `path` and a `pendingAudioId`, and `timerFor` is non-null (no state can wait forever);
   - `error` and `confirm` and `idle` have no `pendingAudioId`;
   - every state is left by `goHome` to `idle`;
   - `sent` only follows a promptResult ok with awaitingSentAck true.
3. Swift drift test: read `targets/watch/PhoneLink.swift` as text (fs) and assert (a) the `VoiceStep` enum cases equal `VOICE_STATES` (case names `idle, recording, transcribing, confirm, error, sent`), (b) `messageTimeoutSeconds`, `fileTransferTimeoutSeconds`, `maxBase64Characters` in the Swift file equal CONSTANTS, (c) the Swift timer callback and the model agree: the error text for the timeout contains "No answer".
4. Timing invariant test: read `src/voice.ts` for the phone's rpc timeout and compare to `messageTimeoutSeconds`. The watch must wait at least as long as the phone's own transcription deadline plus 3 s, otherwise the watch says "No answer" while the Mac is still transcribing. If this fails today, DO NOT change the constants: make it `test.todo`-style by writing the failing numbers in your reply and mark the test with `it.failing` so the suite stays green, and say so clearly.

## Rules
Do not edit Swift, `watchBridge.ts`, `watchVoice.ts` or `voice.ts`. Keep it small and match the surrounding TypeScript style.
Reply with the single line: `voice chart done`, then one line each for anything you found that looked wrong.
