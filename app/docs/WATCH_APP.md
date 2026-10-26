# Watch app

Status: voice flow built, untested on a real watch (W2). The W1 snapshot slice works end to end in the simulators.

## Notification service extension (PS4)

`targets/notification-service/` is a `UNNotificationServiceExtension` target (bundle id
`sg.comex.zode.notification-service`) that decrypts sealed pushes before iOS shows
them: it reads the push key from the shared keychain access group
`XP5Q8LPH52.sg.comex.zode.shared` (the app stores it there with expo-secure-store's
`accessGroup` option), opens the AES-GCM box with the kind as AAD, and replaces
title/body. `userInfo` and the category are kept untouched so the app can still
answer actions. On any failure (no key, tamper, wrong kind, bad JSON) the unchanged
placeholder push (`Zode` / `Open Zode`) is delivered. The fixed test vector lives in
`targets/notification-service/VECTOR.md` (`__tests__/pushVectorSwift.test.ts` keeps
the `sealed:` line in sync).

## Architecture

A watchOS target lives next to the phone app and talks to it over WatchConnectivity.
Message names: `snapshot` (phone → watch), `hello` (watch → phone), and the W2 voice
pair `audio`/`transcript` plus `prompt`/`result`.

| Direction | Message | Payload |
| --- | --- | --- |
| watch → phone | `hello` | `{ type: "hello", at: <epoch ms> }` — `sendMessage` with reply handler, `transferUserInfo` fallback |
| phone → watch | `snapshot` | `{ ok: true, status, servers, defaultSessionId, sessions: [{ id, project, title, state }] }` — at most 8 rows, needs-you first, `defaultSessionId` = first needs-you row else the most recent; the `hello` reply and the `updateApplicationContext` push (throttled 2 s) |
| watch → phone | `audio` | **Reachable (W3):** a normal message `{ type: "audio", id, sessionId, format: "m4a" \| "wav", audioBase64: <base64 clip> }` sent with `sendMessage`; the transcript comes straight back through the reply handler. The base64 is capped at 900 KB on the watch (~55 s of 16 kHz AAC is far below). **Fallback (not reachable, or the send failed):** `WCSession.transferFile` with metadata `{ type: "audio", id, sessionId, format }`, and the transcript arrives as a separate message. Clip: AAC m4a 16 kHz mono from the watch mic, capped at 55 s. |
| phone → watch | `transcript` | `{ type: "transcript", id, ok: true, text }` or `{ type: "transcript", id, ok: false, message }` — arrives through the `audio` reply handler (message path) or as a separate message (file path); `message` is already plain English (`voiceErrorText`); `Voice is not available on your Mac…` when `features.stt` is false or the relay is down |
| watch → phone | `prompt` | `{ type: "prompt", id, sessionId, text }` — plain text only, sent with `session/send` (same params as the chat) |
| phone → watch | `result` | `{ type: "result", id, ok: true }` or `{ type: "result", id, ok: false, message }` — friendly text via `friendlyError`; immediate `Your phone cannot reach your Mac.` when the relay is down |

- **Phone** — `src/watchBridge.ts` (hello + snapshot + the W2/W3 `audio`/`prompt`
  handling; a reachable `audio` message is transcribed straight from its
  `audioBase64`, the file-transfer fallback is read with expo-file-system — both go
  through `transcribeClip`) and `src/watchVoice.ts` (pure: `pickDefaultSession`,
  `parseWatchAudio`, `parseWatchPrompt`, `buildTranscriptReply`, `buildPromptReply`).
  Mounted once in `app/_layout.tsx` inside the relay provider. Demo mode works end to
  end (`DemoClient` answers `stt/transcribe` and `session/send`). W4: fetches and
  pushes are component-level and throttled (2 s), a fetch always ends in a push even
  when it fails, an empty list refetches sooner than the throttle window, and a
  `hello` with an empty list fetches before replying. The watch microphone permission
  is requested exactly once, on the first mic tap — never at launch.
- **Watch** — `targets/watch/`: `PhoneLink.swift` owns the `WCSession` and the voice
  state machine (record → transcribing → confirm → sent; 25 s transcript timeout),
  `ContentView.swift` (home: target picker, mic, `Continue`/`Yes`/`No`/`Stop` quick
  chips, DEBUG buttons), `VoiceFlowView.swift` (recording/transcribing/confirm/error/
  sent screens). `test-clip.wav` is a resource of the target (synchronized folder);
  the `Send test clip` button (`#if DEBUG`) sends it as if recorded.

## Spike notes

Files: `targets/watch/{expo-target.config.js, Info.plist, ZodeWatchApp.swift,
PhoneLink.swift, ContentView.swift, VoiceFlowView.swift, test-clip.wav}`,
`src/watchBridge.ts`, `src/watchVoice.ts`, mounted in `app/_layout.tsx`;
`app.json` carries the `@bacons/apple-targets` plugin entry.

Build (exact commands are run by hand): `npx expo prebuild -p ios --clean`, then
`pod install`, then run the `ZodeWatch` scheme on a watchOS simulator paired with an
iOS simulator from Xcode. All target files live outside `ios/`; every
`expo prebuild --clean` re-links them (see the `@bacons/apple-targets` README).

## How to test in the simulators

1. Prebuild and install: `npx expo prebuild -p ios --clean`, `pod install`, then in
   Xcode run the main app on an iPhone simulator and the `ZodeWatch` scheme on the
   paired watch simulator (the mic permission prompt appears on first tap; the watch
   simulator itself has no microphone input).
2. In the phone app, pair or start the demo — the watch gets a snapshot
   (`defaultSessionId` preselected) and shows `Phone: reachable`.
3. `Send test clip` (debug): the clip is transferred, transcribed by the Mac's
   Whisper through the relay, and the transcript screen shows
   `Add a dark mode toggle to the settings page` in demo mode. Tap `Send` — the text
   lands in that conversation as a prompt.
4. Quick chips send their word immediately; the home line confirms (`Sent "Yes"`).
5. Voice away from the Mac: stop the relay — the watch shows the plain failure
   (`Voice is not available on your Mac…` for clips, `Your phone cannot reach your
   Mac.` for prompts) and offers `Type instead`-style retry paths.
