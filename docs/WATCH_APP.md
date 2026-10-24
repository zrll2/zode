# Zode for Apple Watch (plan)

Status: planned, nothing built. Goal: raise your wrist, speak, and the words land in a Zode conversation as a prompt, in under five seconds, without taking out the phone.

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

## Speech to text, in two tiers
| Tier | How | Good for | Cost |
|---|---|---|---|
| **0, dictation (MVP)** | watchOS system dictation, text field with edit | Short prompts, zero setup, English and Chinese | Audio goes to Apple |
| **1, precise** | Record on the watch (16 kHz mono, about 30 to 60 KB per 10 s) → phone → relay `stt/transcribe` → a Whisper engine on the Mac → transcript back to the watch for confirmation | Code terms, project names, mixed English and Chinese, privacy (audio stays on your network) | A voice engine on the Mac |
| 2, later | Whisper on the iPhone (WhisperKit) when the Mac is unreachable | Away from the Mac | App size |

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

Caveats: clean synthetic speech, not a noisy wrist microphone; one clip, a few runs. It shows the engine is fast enough: `small` at about 1 s is the default candidate, `base.en` the fast mode. Also: on Python 3.14 the audio-decoding dependency (PyAV) failed to install, so faster-whisper could only be fed raw samples. A Python environment inside a notarized Mac app is a packaging risk.

### Engine choice on the Mac
faster-whisper is CPU-only on macOS (no Metal). whisper.cpp (one binary, Metal and Core ML) and MLX Whisper are accelerated on Apple silicon. Plan: an `stt` engine adapter in the Mac app with the OpenAI-compatible interface above; ship **whisper.cpp** as the default (single binary, model downloaded on demand) and support **faster-whisper** as an optional engine (it is also the right choice for Linux and CUDA hosts). Benchmark whisper.cpp on this Mac before fixing the default.

## Privacy and limits
- Tier 1 audio never leaves your network. Tier 0 sends audio to Apple, and the UI says so.
- The new relay method is allow-listed with a size limit (about 2 MB, 30 s) and a rate limit; transcripts are not stored.
- **Approvals on the watch** need push notifications (the phone app is suspended in the background, so a local relay event cannot wake it). Without a push service, approvals on the wrist work only while the phone app is awake. This is a real limit; the first release does not promise it.

## Phases
1. **Spike:** a watch target builds with our local Xcode path, installs on the paired watch simulator, and says hello to the phone over WatchConnectivity.
2. **Dictation MVP:** target selection, dictate, confirm, send. Tier 0 only.
3. **Quick replies and complication:** one-tap replies, the needs-you count.
4. **Voice engine on the Mac:** the `stt` adapter, relay `stt/transcribe`, vocabulary hints from live conversations.
5. **Precise mode on the watch:** record, transfer, transcribe, confirm.
6. **Polish and release:** Smart Stack widget, double-tap to send (watchOS 11), Action button, watch screenshots for the App Store, TestFlight.

## Risks and open questions
- Expo plus a watch target is supported through config plugins but is not our daily path; the spike answers it.
- WatchConnectivity reachability is flaky; queued sends and clear "waiting for phone" states are required.
- App Store review needs a watch app listing and screenshots for the watch sizes.
- Model download sizes: small is about 480 MB, base.en about 150 MB. Download on first use, on Wi-Fi.
- Chinese: dictation covers it; Whisper `small` is multilingual but should be tested on Mandarin and mixed speech.
- When the Mac sleeps, tier 1 is unavailable; tier 0 still works.

## Decisions needed
1. Start with tier 0 (dictation) alone, then add Whisper (recommended), or go straight to the Whisper path?
2. Languages to support first: English only, or English and Chinese?
3. Approvals on the watch: skip for now, or plan a small push service?
