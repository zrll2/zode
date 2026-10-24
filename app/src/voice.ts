// Voice input: record on the phone, transcribe on the user's own Mac via the
// relay's stt rpcs. The state machine is a plain controller (testable with
// injected fakes); the hook wires it to expo-audio and expo-file-system.
// Audio is held in memory only, sent once, never stored or logged.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AudioModule, RecordingPresets, useAudioRecorder } from "expo-audio";
import { File } from "expo-file-system";
import { parseSessionList } from "./util";

export type VoiceState = "idle" | "recording" | "transcribing";
export type TranscribeFormat = "wav" | "m4a" | "caf" | "mp3" | "ogg" | "flac";

export interface VoiceHint {
  projects?: string[];
  titles?: string[];
}

// The relay refuses clips past ~60 s; stop recording before that.
export const MAX_RECORDING_SECONDS = 55;
const PERMISSION_TEXT = "Allow the microphone for Zode in Settings to use voice.";

// Plain sentences for the relay's stt error reasons (rpc error code -32020).
export function voiceErrorText(reason: string): string {
  switch (reason) {
    case "no-model":
      return "Your Mac has not downloaded the voice model yet. Open Zode on the Mac, Settings, Voice.";
    case "busy":
    case "rate-limited":
      return "Voice is busy, try again in a moment.";
    case "too-long":
    case "too-large":
      return "That recording is too long. Keep it under a minute.";
    case "voice-off":
    case "no-engine":
      return "Voice is not available on your Mac. Update Zode on the Mac.";
    default:
      return "Could not turn that into text. Try again.";
  }
}

type RpcFn = (method: string, params: Record<string, unknown>) => Promise<unknown>;

// The client flattens relay errors to their message; the reason may ride
// along as a field or inside that message.
function reasonOf(error: unknown): string {
  if (error && typeof error === "object") {
    const anyError = error as {
      reason?: unknown;
      data?: { reason?: unknown };
      message?: unknown;
    };
    if (typeof anyError.reason === "string") return anyError.reason;
    if (anyError.data && typeof anyError.data === "object") {
      const reason = (anyError.data as { reason?: unknown }).reason;
      if (typeof reason === "string") return reason;
    }
    if (typeof anyError.message === "string") {
      const match =
        /\b(no-engine|no-model|bad-audio|too-long|timeout|engine-failed|busy|bad-params|too-large|rate-limited|voice-off)\b/.exec(
          anyError.message,
        );
      if (match?.[1]) return match[1];
    }
  }
  return "";
}

export interface TranscribeClipInput {
  rpc: RpcFn;
  base64: string;
  format: TranscribeFormat;
  language?: "en" | "zh";
  hint?: VoiceHint;
}

export type TranscribeResult = { ok: true; text: string } | { ok: false; message: string };

// stt/transcribe: never throws; the text comes back trimmed.
export async function transcribeClip(input: TranscribeClipInput): Promise<TranscribeResult> {
  try {
    const result = (await input.rpc("stt/transcribe", {
      audio: input.base64,
      format: input.format,
      ...(input.language ? { language: input.language } : {}),
      ...(input.hint ? { hint: input.hint } : {}),
    })) as { ok?: unknown; text?: unknown } | null;
    const text = typeof result?.text === "string" ? result.text.trim() : "";
    if (!text) return { ok: false, message: voiceErrorText("") };
    return { ok: true, text };
  } catch (error: unknown) {
    return { ok: false, message: voiceErrorText(reasonOf(error)) };
  }
}

export interface VoiceRecorder {
  prepare(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  uri(): Promise<string | null>;
  reset(): void;
}

export interface VoiceSnapshot {
  state: VoiceState;
  seconds: number;
  error: string | null;
}

// What the Composer needs to render the mic / recording strip.
export interface ComposerVoice {
  available: boolean;
  state: VoiceState;
  seconds: number;
  onStart: () => void;
  onStop: () => void;
  onCancel: () => void;
  error?: string | null;
}

export interface VoiceControllerDeps {
  getAvailable(): boolean;
  getRpc(): RpcFn;
  getHint(): VoiceHint | undefined;
  getLanguage(): "en" | "zh" | undefined;
  getOnText(): ((text: string) => void) | undefined;
  getRecorder(): VoiceRecorder;
  getRequestPermission(): () => Promise<boolean>;
  getReadAudio(): (uri: string) => Promise<{ base64: string; format: TranscribeFormat }>;
}

export interface VoiceController {
  subscribe(listener: (snapshot: VoiceSnapshot) => void): () => void;
  getSnapshot(): VoiceSnapshot;
  start(): void;
  stop(): void;
  cancel(): void;
}

// idle → (permission, prepare) → recording → transcribing → idle. Cancel
// discards the clip; stop sends it. Auto-stops at 55 s.
export function createVoiceController(deps: VoiceControllerDeps): VoiceController {
  let state: VoiceState = "idle";
  let seconds = 0;
  let error: string | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let finishing = false;
  const listeners = new Set<(snapshot: VoiceSnapshot) => void>();

  const snapshot = (): VoiceSnapshot => ({ state, seconds, error });
  const emit = () => {
    const value = snapshot();
    for (const listener of listeners) listener(value);
  };
  const set = (patch: Partial<VoiceSnapshot>) => {
    if (patch.state !== undefined) state = patch.state;
    if (patch.seconds !== undefined) seconds = patch.seconds;
    if (patch.error !== undefined) error = patch.error;
    emit();
  };
  const clearTimer = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  async function finish(transcribe: boolean): Promise<void> {
    if (state !== "recording" || finishing) return;
    finishing = true;
    clearTimer();
    if (!transcribe) {
      try {
        await deps.getRecorder().stop();
      } catch {}
      deps.getRecorder().reset();
      set({ state: "idle", seconds: 0, error: null });
      finishing = false;
      return;
    }
    set({ state: "transcribing" });
    let text: string | null = null;
    let message: string | null = null;
    try {
      await deps.getRecorder().stop();
      const uri = await deps.getRecorder().uri();
      if (!uri) throw new Error("no recording");
      const audio = await deps.getReadAudio()(uri);
      const result = await transcribeClip({
        rpc: deps.getRpc(),
        base64: audio.base64,
        format: audio.format,
        language: deps.getLanguage(),
        hint: deps.getHint(),
      });
      if (result.ok) text = result.text;
      else message = result.message;
    } catch {
      message = voiceErrorText("");
    }
    try {
      deps.getRecorder().reset();
    } catch {}
    if (text) deps.getOnText()?.(text);
    set({ state: "idle", seconds: 0, error: message });
    finishing = false;
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      listener(snapshot());
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: snapshot,
    start() {
      void (async () => {
        if (!deps.getAvailable() || state !== "idle" || finishing) return;
        set({ error: null });
        let granted = false;
        try {
          granted = await deps.getRequestPermission()();
        } catch {
          granted = false;
        }
        if (!granted) {
          set({ error: PERMISSION_TEXT });
          return;
        }
        try {
          await deps.getRecorder().prepare();
          await deps.getRecorder().start();
        } catch {
          set({ error: voiceErrorText("") });
          return;
        }
        set({ state: "recording", seconds: 0 });
        const startedAt = Date.now();
        clearTimer();
        timer = setInterval(() => {
          const value = Math.floor((Date.now() - startedAt) / 1000);
          set({ seconds: value });
          if (value >= MAX_RECORDING_SECONDS) void finish(true);
        }, 1000);
      })();
    },
    stop() {
      void finish(true);
    },
    cancel() {
      void finish(false);
    },
  };
}

// ---- defaults wired to expo-audio / expo-file-system ----

// The slice of expo-audio's AudioRecorder the adapter uses (names as in its type definitions).
interface ExpoRecorderLike {
  prepareToRecordAsync: () => Promise<void>;
  record: () => void;
  stop: () => Promise<void>;
  uri: string | null;
}

function expoRecorderAdapter(recorder: ExpoRecorderLike): VoiceRecorder {
  return {
    prepare: async () => {
      await recorder.prepareToRecordAsync();
    },
    start: async () => {
      recorder.record();
    },
    stop: async () => {
      await recorder.stop();
    },
    uri: async () => recorder.uri ?? null,
    reset: () => {
      void recorder.stop().catch(() => {});             // abandon a recording: stopping is the only way to release it
    },
  };
}

async function defaultRequestPermission(): Promise<boolean> {
  const permission = await AudioModule.requestRecordingPermissionsAsync();
  return Boolean(permission?.granted);
}

export function audioFormatOf(uri: string): TranscribeFormat {
  const match = /\.(m4a|wav|caf|mp3|ogg|flac)$/i.exec(uri);
  return (match?.[1] ?? "m4a") as TranscribeFormat;
}

async function defaultReadAudio(uri: string): Promise<{ base64: string; format: TranscribeFormat }> {
  const file = new File(uri);
  const base64 = await file.base64();
  return { base64, format: audioFormatOf(uri) };
}

export interface VoiceInputOptions {
  rpc: RpcFn;
  available: boolean;
  hint?: VoiceHint;
  language?: "en" | "zh";
  onText?: (text: string) => void;
  // Injectable for tests; defaults use expo-audio's recorder.
  recorder?: VoiceRecorder;
  requestPermission?: () => Promise<boolean>;
  readAudio?: (uri: string) => Promise<{ base64: string; format: TranscribeFormat }>;
}

// Thin hook: state comes from the controller, the native recorder from
// expo-audio. `onText` receives each finished transcription.
export function useVoiceInput(options: VoiceInputOptions) {
  const expoRecorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recorder = useMemo<VoiceRecorder>(
    () => options.recorder ?? expoRecorderAdapter(expoRecorder),
    [options.recorder, expoRecorder],
  );
  const requestPermission = useCallback(
    () => (options.requestPermission ? options.requestPermission() : defaultRequestPermission()),
    [options.requestPermission],
  );
  const readAudio = useCallback(
    (uri: string) => (options.readAudio ? options.readAudio(uri) : defaultReadAudio(uri)),
    [options.readAudio],
  );

  const live = useRef(options);
  live.current = options;

  const controllerRef = useRef<VoiceController | null>(null);
  if (controllerRef.current === null) {
    controllerRef.current = createVoiceController({
      getAvailable: () => live.current.available,
      getRpc: () => live.current.rpc,
      getHint: () => live.current.hint,
      getLanguage: () => live.current.language,
      getOnText: () => live.current.onText,
      getRecorder: () => (live.current.recorder ?? recorder),
      getRequestPermission: () => (live.current.requestPermission ?? defaultRequestPermission),
      getReadAudio: () => (live.current.readAudio ?? defaultReadAudio),
    });
  }
  const controller = controllerRef.current;

  const [snapshot, setSnapshot] = useState<VoiceSnapshot>(controller.getSnapshot());
  useEffect(() => controller.subscribe(setSnapshot), [controller]);

  // Leaving the screen discards any recording; nothing is kept.
  useEffect(() => () => controller.cancel(), [controller]);

  return {
    state: snapshot.state,
    seconds: snapshot.seconds,
    error: snapshot.error,
    start: controller.start,
    stop: controller.stop,
    cancel: controller.cancel,
  };
}

// Best-effort transcription hint from the session list: project names and
// recent titles, capped at 2 KB of JSON.
export function buildVoiceHint(
  rows: { title: string; folder: string }[],
): VoiceHint | undefined {
  const seen = new Set<string>();
  let projects: string[] = [];
  for (const row of rows) {
    const folder = row.folder.trim();
    if (folder && !seen.has(folder)) {
      seen.add(folder);
      projects.push(folder);
    }
  }
  let titles = rows.map((row) => row.title.trim()).filter(Boolean).slice(0, 20);
  while ((projects.length > 0 || titles.length > 0) && JSON.stringify({ projects, titles }).length > 2048) {
    if (titles.length > 0) titles = titles.slice(0, -1);
    else projects = projects.slice(0, -1);
  }
  if (projects.length === 0 && titles.length === 0) return undefined;
  return { projects, titles };
}

// Fetches the hint once per enabled mount; failures just leave it off.
export function useVoiceHint(options: { rpc: RpcFn; enabled: boolean }): VoiceHint | undefined {
  const { enabled } = options;
  const rpcRef = useRef(options.rpc);
  rpcRef.current = options.rpc;
  const [hint, setHint] = useState<VoiceHint | undefined>(undefined);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void (async () => {
      try {
        const rows = parseSessionList(await rpcRef.current("session/list", {}));
        if (!cancelled) setHint(buildVoiceHint(rows));
      } catch {
        // the hint is best effort
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return hint;
}
