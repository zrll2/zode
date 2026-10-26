# Zode for Apple Watch (plan)

Status: planned, nothing built. Decisions made: Whisper on the Mac first (dictation only as a fallback), English and Chinese, and a small push service for approvals. Goal: raise your wrist, speak, and the words land in a Zode conversation as a prompt, in under five seconds, without taking out the phone.

## The flow
1. Open Zode on the watch (or tap its complication, or the Ultra Action button).
2. The target is already chosen: the conversation that needs you, otherwise the last one you used. A tap on the name switches among the five most recent.
3. Tap the microphone and talk. The transcript appears with **Send** and **Redo**. Send gives a haptic.
4. One-tap quick replies sit next to the microphone: Continue, Yes, No, Stop, "Explain what you are doing".
5. The complication shows how many conversations need you.

## Architecture
```
 Watch (SwiftUI)  ──WatchConnectivity──▶  iPhone app (existing, React Native + a small Swift bridge)  ──websocket──▶  relay on the Mac  ──▶  ZCode / other backends
        ▲                                                                                                     │
        └──────────── transcript and status come back the same way ◀───────────────────────────────────────────┘
```
- **The watch never holds a pairing token.** The iPhone keeps the relay connection and proxies. If the phone is out of reach the watch queues the prompt (`transferUserInfo`) and tells you it is waiting.
- **Watch target in an Expo project:** a native SwiftUI watchOS target added through a config plugin (for example `@bacons/apple-targets`) so `expo prebuild` and our local Xcode build both include it. A small Swift module on the phone side exposes `setSnapshot(sessions)` to the watch and delivers `prompt` messages to JavaScript, which sends them through the existing relay client (`session/send`).
- **Messages (watch ↔ phone):** `snapshot { sessions: [{ id, project, title, status }], needsYou }`, `prompt { sessionId, text }`, `promptAudio { sessionId, file }`, `result { ok, message }`.

## Speech to text: Whisper first, dictation as the fallback
| Tier | How | Good for | Cost |
|---|---|---|---|
| **Fallback, dictation** | watchOS system dictation, text field with edit | When the Mac is unreachable or asleep; English and Chinese | Audio goes to Apple |
| **Main, Whisper on the Mac** | Record on the watch (16 kHz mono, about 30 to 60 KB per 10 s) → phone → relay `stt/transcribe` → a Whisper engine on the Mac → transcript back to the watch for confirmation | Code terms, project names, mixed English and Chinese, privacy (audio stays on your network) | A voice engine on the Mac |
| Later | Whisper on the iPhone (WhisperKit) | Away from the Mac with no Mac | App size |

### What faster-whisper teaches us
From the SYSTRAN repo: a CTranslate2 reimplementation of Whisper, up to 4x faster than the original at equal accuracy, with 8-bit CPU quantization. The ideas worth taking:
- **int8 on CPU**, **beam size 1** for latency, **fixed language** (no auto-detect on short clips).
- **VAD filter (Silero)** to drop silence and avoid made-up text from noise; **`condition_on_previous_text=False`** for one-shot prompts.
- **`initial_prompt` / vocabulary hints** seeded with project names, conversation titles and code words (worktree, OpenCode, relay, TestFlight) so they are heard right.
- **Keep the model loaded** (load takes 0.6 to 1.2 s; do not pay it per prompt).
- **OpenAI-compatible local server** (the `speaches` project does this): a `/v1/audio/transcriptions` interface makes engines interchangeable.
- Streaming partials (Whisper-Streaming, WhisperLive) and batched inference are not needed for prompts under 30 s.

### Measured on this Mac mini (Apple silicon, CPU int8, beam 1, VAD on, an 8.6 s synthetic spoken prompt)
| Model | Transcribe time (warm) | Result |
|---|---|---|
| base.en | 0.35 s | correct |
| small (multilingual) | 1.1 s | correct |
| distil-large-v3 | 3.3 s | correct, wrote "work tree" |

### Chinese and mixed Chinese-English (same Mac, synthetic Mandarin voice, a 10 s and an 8 s prompt)
| Engine and model | Time | Notes |
|---|---|---|
| faster-whisper small, language fixed to zh | 3.2 s and 2.4 s | printed **Traditional** characters; one wrong word (核 for 和); English words half-right ("checkout the flaggy test") |
| faster-whisper small, language auto | 4.0 s and 3.1 s | same text; slower; mixed-in English words capitalised as separate words |
| faster-whisper turbo, language fixed to zh | 5.7 s and 4.5 s | Simplified in one clip, Traditional in the other; correct on the first; English words kept as typed |
| faster-whisper turbo, language auto | 10.0 s and 9.0 s | about twice as slow as fixed, no better |
| **whisper.cpp small (GPU)**, language fixed | **0.8 s and 0.7 s** including start-up and model load | Simplified, same single wrong word; same English-word slips |

What this says: fixing the language is faster and no worse than auto-detect, so make it a setting. whisper.cpp with the Mac's GPU is about four times faster than faster-whisper on the CPU for the same model, so it becomes the **default engine**. Whisper tends to print Traditional characters unless nudged: start the vocabulary hint with a Simplified sentence. English code words inside Chinese speech ("worktree", "merge", "sudo") are the weak spot: seed them in the hint and show the transcript for confirmation before sending. The very first whisper.cpp call took 7 s (GPU warm-up), so the app keeps the engine warm.

Caveats: clean synthetic speech, not a noisy wrist microphone; one clip, a few runs. It shows the engine is fast enough: `small` at about 1 s is the default candidate, `base.en` the fast mode. Also: on Python 3.14 the audio-decoding dependency (PyAV) failed to install, so faster-whisper could only be fed raw samples. A Python environment inside a notarized Mac app is a packaging risk.

### Engine choice on the Mac
**Decided: whisper.cpp** as the default (one binary, GPU on Apple silicon, model downloaded on first use: `small` is about 490 MB), behind an `stt` adapter with an OpenAI-compatible `/v1/audio/transcriptions` interface so engines stay swappable. **faster-whisper** stays an optional engine (the right choice for Linux and CUDA hosts; on a Mac it is CPU-only and a Python environment is fragile inside a notarized app).

## Push service (small, hosted by the app publisher)
**Why it exists.** The relay runs on your Mac and the phone app is suspended in the background, so approvals, questions and failures cannot reach you until you open the app. Apple only allows notifications through its push service (APNs), and APNs needs a signing key that belongs to the app's publisher. That key cannot ship inside each user's Mac app, so one small service holds it and forwards.

**Flow.**
1. The phone app registers with APNs and gets a **device token**.
2. The phone sends the token to the service (`POST /register`). The service returns an opaque **push id** and a secret. The push id is the device token **encrypted with a server key**, so the service stores nothing.
3. The phone gives the push id and secret to your Mac's relay over the existing authenticated connection.
4. When something happens (an approval is asked, a question, a failure, a conversation stalls), the relay sends `POST /push { pushId, auth, kind, sealed }` to the service, which decrypts the token and calls APNs.

**Privacy.** The notification text is **end-to-end encrypted** between the Mac and the phone with a key made at pairing. The push carries only ciphertext (`mutable-content`); a Notification Service Extension on the phone decrypts it and shows "shop: Run npm install". The service and Apple see the push id, the kind and a size, never the command or the conversation.

**What the notification can do.** Actions on the phone and the watch: **Allow once**, **Deny**, and **Reply** (a text-input action: dictate on the watch, and the words go to that conversation). The action handler runs in the background and sends the answer to the relay, so it needs the relay to be reachable (same Wi-Fi or Tailscale); otherwise it opens the app.

**Noise control.** The relay skips the push when a phone is connected and active in the last 30 seconds, merges bursts, and lets you mute per project or per kind. Default kinds: asks, questions, failures and "stuck 10 min". "Finished" is off by default.

**Build.** One serverless function (Vercel, which we already use) with the APNs key and the encryption key as secrets, HTTP/2 to `api.push.apple.com` with a signed token, abuse limits per push id (a small key-value store only for rate counters), a fixed topic (our bundle id) and a payload cap. Provider-agnostic request shape (`platform` field) leaves room for Android (FCM) later. About 200 lines.

**What I need from you.** An **APNs key** (Apple Developer, Keys, enable Apple Push Notifications service), which is different from the App Store Connect key made earlier. Like that one, it is created in your account; the `.p8` file goes into the service's secrets, never into the repository.

**Limits and honesty.**
- Push is best effort. Everything still works in the app without it.
- It adds one hosted dependency run by Comex Technologies Pte Ltd, and the privacy policy and App Store data disclosure must say what is stored (a device token, encrypted) and that content is not readable.
- The free tier of the host and APNs cost nothing at this scale.
- A user who builds their own copy of the app would need their own service and key.

## Privacy and limits
- Tier 1 audio never leaves your network. Tier 0 sends audio to Apple, and the UI says so.
- The new relay method is allow-listed with a size limit (about 2 MB, 30 s) and a rate limit; transcripts are not stored.
- **Approvals on the watch** ride on the push service above (the notification actions appear on the watch).

## Phases (Whisper first, push in parallel)
1. **Voice engine on the Mac:** the `stt` adapter around whisper.cpp, model download on first use, language setting (English, Chinese, fixed per prompt), vocabulary hint from live conversations (project names, titles, code words), relay method `stt/transcribe` with size and rate limits, tested from a recorded clip with no watch involved.
2. **Watch spike:** a watch target builds with our local Xcode path, installs on the paired watch simulator and says hello to the phone over WatchConnectivity.
3. **Watch voice flow:** record, transfer to the phone, relay, transcribe, confirm, send. Target selection and quick replies. Dictation as the fallback when the Mac is unreachable.
4. **Push service:** the function, registration, the Notification Service Extension, encrypted payloads, Allow, Deny and Reply actions on phone and watch. (Needs the APNs key.)
5. **Complication and polish:** needs-you count, Smart Stack widget, double-tap to send (watchOS 11), Action button, watch screenshots, TestFlight.

## Risks and open questions
- Expo plus a watch target is supported through config plugins but is not our daily path; the spike answers it.
- WatchConnectivity reachability is flaky; queued sends and clear "waiting for phone" states are required.
- App Store review needs a watch app listing and screenshots for the watch sizes.
- Model download sizes: small is about 480 MB, base.en about 150 MB. Download on first use, on Wi-Fi.
- Chinese: dictation covers it; Whisper `small` is multilingual but should be tested on Mandarin and mixed speech.
- When the Mac sleeps, tier 1 is unavailable; tier 0 still works.

## Decisions made
- Whisper on the Mac first; dictation only as a fallback.
- English and Chinese, language fixed per prompt (setting), with a vocabulary hint.
- A small push service, hosted by the app publisher, for approvals, questions and replies.
- whisper.cpp as the default engine, faster-whisper optional.

## Still open
- Which model by default: `small` (about 1 s, a little weaker on mixed speech) or a larger one (slower, better on code words)? Decide after testing real recordings from the watch.
- Whether to ship the push service for Android users when an Android client exists.
