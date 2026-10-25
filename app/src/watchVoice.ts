// Pure parts of the watch voice flow (W2): the watch records a clip or
// composes a prompt, the phone transcribes/sends it. No React, no network.

import { friendlyError } from "./friendlyError";
import type { WatchRow } from "./watchBridge";

export type WatchAudioFormat = "m4a" | "wav";

const MAX_AUDIO_BYTES = 3 * 1024 * 1024; // the relay refuses clips over 3 MB decoded
const MAX_PROMPT_LENGTH = 4_000;

export interface WatchAudioMeta {
  id: string;
  sessionId: string;
  format: WatchAudioFormat;
  // Present when the clip rode inside a reachable message instead of a file
  // transfer; the phone transcribes this directly without touching disk.
  audioBase64?: string;
}

export type TranscriptReply =
  | { type: "transcript"; id: string; ok: true; text: string }
  | { type: "transcript"; id: string; ok: false; message: string };

export type PromptReply =
  | { type: "result"; id: string; ok: true }
  | { type: "result"; id: string; ok: false; message: string };

export function voiceUnavailableText(): string {
  return "Voice is not available on your Mac. Update Zode on the Mac.";
}

export function phoneUnreachableText(): string {
  return "Your phone cannot reach your Mac.";
}

// First needs-you row, else the most recent row, else nothing.
export function pickDefaultSession(rows: unknown): WatchRow | null {
  if (!Array.isArray(rows)) return null;
  let fallback: WatchRow | null = null;
  let fallbackUpdatedAt = -1;
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const candidate = row as Partial<WatchRow>;
    if (typeof candidate.id !== "string" || !candidate.id) continue;
    const value: WatchRow = {
      id: candidate.id,
      project: typeof candidate.project === "string" ? candidate.project : "",
      title: typeof candidate.title === "string" ? candidate.title : "",
      state: candidate.state === "needs" || candidate.state === "working" ? candidate.state : "idle",
    };
    const updatedAt =
      typeof (row as { updatedAt?: unknown }).updatedAt === "number"
        ? ((row as { updatedAt: number }).updatedAt)
        : 0;
    if (value.state === "needs") return value;
    if (updatedAt >= fallbackUpdatedAt) {
      fallback = value;
      fallbackUpdatedAt = updatedAt;
    }
  }
  return fallback;
}

// Validates what rides along the watch's audio: either file-transfer
// metadata (bytes checked against the cap) or a message-embedded clip
// (`audioBase64`, decoded size checked against the cap). Junk in, null out.
export function parseWatchAudio(meta: unknown, bytes?: unknown): WatchAudioMeta | null {
  if (!meta || typeof meta !== "object") return null;
  const candidate = meta as {
    id?: unknown;
    rid?: unknown;
    sessionId?: unknown;
    format?: unknown;
    audioBase64?: unknown;
  };
  const clipId = typeof candidate.rid === "string" && candidate.rid ? candidate.rid : candidate.id;
  if (typeof clipId !== "string" || !clipId) return null;
  if (typeof candidate.sessionId !== "string" || !candidate.sessionId) return null;
  if (candidate.format !== "m4a" && candidate.format !== "wav") return null;
  if (typeof candidate.audioBase64 === "string") {
    if (!candidate.audioBase64) return null;
    const decodedBytes = Math.floor((candidate.audioBase64.length * 3) / 4);
    if (decodedBytes > MAX_AUDIO_BYTES) return null;
    return {
      id: clipId,
      sessionId: candidate.sessionId,
      format: candidate.format,
      audioBase64: candidate.audioBase64,
    };
  }
  if (
    typeof bytes === "number" &&
    Number.isFinite(bytes) &&
    bytes > 0 &&
    bytes > MAX_AUDIO_BYTES
  ) {
    return null;
  }
  return { id: clipId, sessionId: candidate.sessionId, format: candidate.format };
}

// The watch's hello-style payloads arrive untyped; pull the fields out.
export function parseWatchPrompt(payload: unknown): { id: string; sessionId: string; text: string } | null {
  if (!payload || typeof payload !== "object") return null;
  const candidate = payload as { id?: unknown; rid?: unknown; sessionId?: unknown; text?: unknown };
  const clipId = typeof candidate.rid === "string" && candidate.rid ? candidate.rid : candidate.id;
  if (typeof clipId !== "string" || !clipId) return null;
  if (typeof candidate.sessionId !== "string" || !candidate.sessionId) return null;
  const text = typeof candidate.text === "string" ? candidate.text.trim() : "";
  if (!text || text.length > MAX_PROMPT_LENGTH) return null;
  return { id: clipId, sessionId: candidate.sessionId, text };
}

export function buildTranscriptReply(id: string, result: { ok: true; text: string } | { ok: false; message: string }): TranscriptReply {
  if (result.ok) return { type: "transcript", id, ok: true, text: result.text };
  return { type: "transcript", id, ok: false, message: result.message };
}

export function buildPromptReply(id: string, ok: true): Extract<PromptReply, { ok: true }>;
export function buildPromptReply(id: string, ok: false, message?: string): Extract<PromptReply, { ok: false }>;
export function buildPromptReply(id: string, ok: boolean, message?: string): PromptReply {
  if (ok) return { type: "result", id, ok: true };
  return { type: "result", id, ok: false, message: message ?? phoneUnreachableText() };
}

// session/send failures become one plain line for the watch.
export function promptFailureText(error: unknown): string {
  return friendlyError(error);
}
