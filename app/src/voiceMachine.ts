// Pure statechart for the watch voice pipeline (order 18). Mirrors
// targets/watch/PhoneLink.swift — one source of truth for steps, timers and
// transitions, so Swift drift is testable. No React, no native imports.

export const VOICE_STATES = [
  "idle",
  "recording",
  "transcribing",
  "confirm",
  "error",
  "sent",
] as const;

export type VoiceStep = (typeof VOICE_STATES)[number];

// How the clip travels while transcribing: inside a reachable message, or as
// a file transfer fallback.
export type Path = "message" | "file";

export interface VoiceState {
  step: VoiceStep;
  path?: Path;
  pendingAudioId?: string;
  pendingPromptId?: string;
  awaitingSentAck?: boolean;
}

export const CONSTANTS = {
  messageTimeoutSeconds: 63,
  fileTransferTimeoutSeconds: 90,
  maxBase64Characters: 80000,
  minClipSeconds: 1,
  sentResetSeconds: 1.5,
} as const;

export type VoiceEvent =
  | { type: "startRecording" }
  | { type: "finishRecording"; elapsed: number }
  | { type: "cancelRecording" }
  | {
      type: "beginTranscription";
      id: string;
      reachable: boolean;
      base64Chars: number;
      hasSession: boolean;
    }
  | { type: "messageErrored"; id: string }
  | { type: "transcript"; id: string; ok: boolean; text?: string }
  | { type: "transcriptTimeout" }
  | { type: "confirmSend"; text: string }
  | { type: "quickReply"; text: string }
  | { type: "promptResult"; id: string; ok: boolean }
  | { type: "sentReset" }
  | { type: "goHome" }
  | { type: "typed"; text: string };

// Seconds the pending timer should be set to, or null (no timer).
export function timerFor(state: VoiceState): number | null {
  if (state.step === "sent") return CONSTANTS.sentResetSeconds;
  if (state.step === "transcribing") {
    return state.path === "file"
      ? CONSTANTS.fileTransferTimeoutSeconds
      : CONSTANTS.messageTimeoutSeconds;
  }
  return null;
}

const IDLE: VoiceState = { step: "idle" };

// Mirrors PhoneLink.swift:
// - a transcript/messageErrored whose id does not match the pending audio id
//   is ignored;
// - the transcript timeout only acts while transcribing (a late transcript
//   after it is ignored, because the pending id is gone);
// - a failed reachable send switches the path to the file fallback and the
//   timer restarts with the file timeout;
// - a clip shorter than minClipSeconds returns to idle;
// - without a known conversation, transcription is an error.
export function reduce(state: VoiceState, event: VoiceEvent): VoiceState {
  switch (event.type) {
    case "startRecording": {
      if (state.step === "recording" || state.step === "transcribing") return state;
      return { step: "recording" };
    }
    case "finishRecording": {
      if (state.step !== "recording") return state;
      if (event.elapsed < CONSTANTS.minClipSeconds) return IDLE;
      // The follow-up beginTranscription (same code path in Swift) moves the
      // chart to transcribing and carries the clip.
      return state;
    }
    case "cancelRecording": {
      if (state.step !== "recording") return state;
      return IDLE;
    }
    case "beginTranscription": {
      if (state.step !== "recording" && state.step !== "idle") return state;
      if (!event.hasSession) return { step: "error" };
      if (event.reachable && event.base64Chars > CONSTANTS.maxBase64Characters) {
        return { step: "error" };
      }
      return {
        step: "transcribing",
        path: event.reachable ? "message" : "file",
        pendingAudioId: event.id,
      };
    }
    case "messageErrored": {
      if (
        state.step !== "transcribing" ||
        state.path !== "message" ||
        state.pendingAudioId !== event.id
      ) {
        return state;
      }
      // sendMessage failed: the clip goes out as a file transfer instead, and
      // the transcript arrives as a separate message later.
      return { ...state, path: "file" };
    }
    case "transcript": {
      if (state.step !== "transcribing" || state.pendingAudioId !== event.id) return state;
      if (event.ok && typeof event.text === "string" && event.text) {
        return { step: "confirm" };
      }
      return { step: "error" };
    }
    case "transcriptTimeout": {
      if (state.step !== "transcribing") return state;
      return { step: "error" };
    }
    case "confirmSend": {
      if (state.step !== "confirm") return state;
      return { step: "sent", awaitingSentAck: true, pendingPromptId: event.text };
    }
    case "quickReply": {
      // Goes out at once from the home screen; it never shows Sent by itself.
      if (state.step !== "idle") return state;
      return { ...state, pendingPromptId: event.text };
    }
    case "promptResult": {
      if (state.pendingPromptId === undefined || state.pendingPromptId !== event.id) return state;
      if (!event.ok) return { step: "error" };
      // Already showing Sent with its ack timer running; nothing to change.
      return state;
    }
    case "sentReset": {
      if (state.step !== "sent") return state;
      return IDLE;
    }
    case "goHome": {
      return IDLE;
    }
    case "typed": {
      if (state.step === "recording" || state.step === "transcribing") return state;
      return { step: "confirm" };
    }
  }
}
