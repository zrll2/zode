import fs from "fs";
import path from "path";
import { gcm } from "@noble/ciphers/aes.js";
import { utf8ToBytes } from "@noble/ciphers/utils.js";
import {
  CONSTANTS,
  reduce,
  timerFor,
  VOICE_STATES,
  type VoiceEvent,
  type VoiceState,
} from "../src/voiceMachine";

// ---- table tests: one describe per event, including every ignored case ----

const recording: VoiceState = { step: "recording" };
const transcribingMessage: VoiceState = {
  step: "transcribing",
  path: "message",
  pendingAudioId: "a",
};
const transcribingFile: VoiceState = {
  step: "transcribing",
  path: "file",
  pendingAudioId: "b",
};

describe("startRecording", () => {
  it("starts from idle, error, confirm and sent", () => {
    for (const step of ["idle", "error", "confirm", "sent"] as const) {
      expect(reduce({ step }, { type: "startRecording" }).step).toBe("recording");
    }
  });

  it("is a no-op while already recording or transcribing", () => {
    expect(reduce(recording, { type: "startRecording" })).toEqual(recording);
    expect(reduce(transcribingMessage, { type: "startRecording" })).toEqual(transcribingMessage);
  });
});

describe("finishRecording", () => {
  it("drops clips shorter than minClipSeconds back to idle", () => {
    expect(reduce(recording, { type: "finishRecording", elapsed: 0 }).step).toBe("idle");
  });

  it("keeps recording until beginTranscription carries the clip", () => {
    expect(reduce(recording, { type: "finishRecording", elapsed: 5 })).toEqual(recording);
  });

  it("ignores finish while not recording", () => {
    expect(reduce({ step: "idle" }, { type: "finishRecording", elapsed: 5 }).step).toBe("idle");
  });
});

describe("cancelRecording", () => {
  it("returns a recording to idle", () => {
    expect(reduce(recording, { type: "cancelRecording" }).step).toBe("idle");
  });

  it("leaves other states alone", () => {
    expect(reduce({ step: "idle" }, { type: "cancelRecording" }).step).toBe("idle");
    expect(reduce(transcribingMessage, { type: "cancelRecording" })).toEqual(transcribingMessage);
  });
});

describe("beginTranscription", () => {
  it("goes to transcribing over the message path when reachable", () => {
    expect(
      reduce(recording, {
        type: "beginTranscription",
        id: "a",
        reachable: true,
        base64Chars: 1000,
        hasSession: true,
      }),
    ).toEqual({ step: "transcribing", path: "message", pendingAudioId: "a" });
  });

  it("goes to transcribing over the file path when not reachable", () => {
    expect(
      reduce(recording, {
        type: "beginTranscription",
        id: "a",
        reachable: false,
        base64Chars: 1000,
        hasSession: true,
      }),
    ).toEqual({ step: "transcribing", path: "file", pendingAudioId: "a" });
  });

  it("errors on an oversized reachable message", () => {
    expect(
      reduce(recording, {
        type: "beginTranscription",
        id: "a",
        reachable: true,
        base64Chars: CONSTANTS.maxBase64Characters + 1,
        hasSession: true,
      }).step,
    ).toBe("error");
  });

  it("errors without a known conversation", () => {
    expect(
      reduce(recording, {
        type: "beginTranscription",
        id: "a",
        reachable: true,
        base64Chars: 1000,
        hasSession: false,
      }).step,
    ).toBe("error");
  });

  it("starts from idle too (the debug test clip button)", () => {
    expect(
      reduce({ step: "idle" }, {
        type: "beginTranscription",
        id: "a",
        reachable: false,
        base64Chars: 1000,
        hasSession: true,
      }).step,
    ).toBe("transcribing");
  });

  it("ignores a begin while already transcribing", () => {
    expect(reduce(transcribingMessage, {
      type: "beginTranscription",
      id: "b",
      reachable: true,
      base64Chars: 1000,
      hasSession: true,
    })).toEqual(transcribingMessage);
  });
});

describe("messageErrored", () => {
  it("switches the message path to the file fallback", () => {
    const next = reduce(transcribingMessage, { type: "messageErrored", id: "a" });
    expect(next.step).toBe("transcribing");
    expect(next.path).toBe("file");
    expect(timerFor(next)).toBe(CONSTANTS.fileTransferTimeoutSeconds);
  });

  it("ignores a stale id and the file path", () => {
    expect(reduce(transcribingMessage, { type: "messageErrored", id: "b" })).toEqual(
      transcribingMessage,
    );
    expect(reduce(transcribingFile, { type: "messageErrored", id: "b" })).toEqual(
      transcribingFile,
    );
  });
});

describe("transcript", () => {
  it("confirms a good transcript and clears the pending audio id", () => {
    const next = reduce(transcribingMessage, {
      type: "transcript",
      id: "a",
      ok: true,
      text: "hello",
    });
    expect(next.step).toBe("confirm");
    expect(next.pendingAudioId).toBeUndefined();
  });

  it("errors on a failed transcript", () => {
    expect(
      reduce(transcribingMessage, { type: "transcript", id: "a", ok: false }).step,
    ).toBe("error");
  });

  it("ignores a stale id", () => {
    expect(
      reduce(transcribingMessage, { type: "transcript", id: "b", ok: true, text: "hi" }),
    ).toEqual(transcribingMessage);
  });

  it("ignores a late transcript after the timeout", () => {
    const timedOut = reduce(transcribingMessage, { type: "transcriptTimeout" });
    expect(timedOut.step).toBe("error");
    expect(
      reduce(timedOut, { type: "transcript", id: "a", ok: true, text: "late" }),
    ).toEqual(timedOut);
  });

  it("ignores a transcript while idle", () => {
    expect(reduce({ step: "idle" }, { type: "transcript", id: "a", ok: true, text: "x" }).step).toBe(
      "idle",
    );
  });
});

describe("transcriptTimeout", () => {
  it("only acts while transcribing", () => {
    expect(reduce(transcribingMessage, { type: "transcriptTimeout" }).step).toBe("error");
    expect(reduce({ step: "idle" }, { type: "transcriptTimeout" }).step).toBe("idle");
    expect(reduce(transcribingFile, { type: "transcriptTimeout" }).step).toBe("error");
  });
});

describe("confirmSend", () => {
  it("sends from confirm and shows Sent with the ack timer", () => {
    expect(reduce({ step: "confirm" }, { type: "confirmSend", text: "go" })).toEqual({
      step: "sent",
      awaitingSentAck: true,
      pendingPromptId: "go",
    });
  });

  it("does not send from idle", () => {
    expect(reduce({ step: "idle" }, { type: "confirmSend", text: "go" }).step).toBe("idle");
  });
});

describe("quickReply", () => {
  it("sends at once from idle without showing Sent", () => {
    const next = reduce({ step: "idle" }, { type: "quickReply", text: "yes" });
    expect(next.step).toBe("idle");
    expect(next.pendingPromptId).toBe("yes");
    expect(next.awaitingSentAck).toBeUndefined();
  });

  it("does not fire while transcribing", () => {
    expect(reduce(transcribingMessage, { type: "quickReply", text: "yes" })).toEqual(
      transcribingMessage,
    );
  });
});

describe("promptResult", () => {
  it("errors a failed quick reply", () => {
    const pending = reduce({ step: "idle" }, { type: "quickReply", text: "yes" });
    expect(reduce(pending, { type: "promptResult", id: "yes", ok: false }).step).toBe("error");
  });

  it("ignores a non-matching id and an ack without a quick reply", () => {
    const pending = reduce({ step: "idle" }, { type: "quickReply", text: "yes" });
    expect(reduce(pending, { type: "promptResult", id: "a", ok: true })).toEqual(pending);
    expect(reduce({ step: "idle" }, { type: "promptResult", id: "yes", ok: true })).toEqual({
      step: "idle",
    });
  });
});

describe("sentReset, goHome, typed", () => {
  it("returns sent to idle on the reset", () => {
    const sent = reduce({ step: "confirm" }, { type: "confirmSend", text: "go" });
    expect(reduce(sent, { type: "sentReset" }).step).toBe("idle");
    expect(reduce({ step: "sent" }, { type: "sentReset" }).step).toBe("idle");
  });

  it("sends never re-enters idle from a prompt result", () => {
    const sent = reduce({ step: "confirm" }, { type: "confirmSend", text: "go" });
    expect(reduce(sent, { type: "promptResult", id: "go", ok: true })).toEqual(sent);
  });

  it("goHome lands idle from every state", () => {
    for (const step of VOICE_STATES) {
      expect(reduce({ step, path: "message" }, { type: "goHome" }).step).toBe("idle");
    }
  });

  it("typed goes through the same confirm step", () => {
    expect(reduce({ step: "error" }, { type: "typed", text: "hi" }).step).toBe("confirm");
    expect(reduce(transcribingMessage, { type: "typed", text: "hi" })).toEqual(
      transcribingMessage,
    );
  });
});

// ---- model-based: seeded sequences, invariants after every step ----

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const GENERATOR: VoiceEvent[] = [
  { type: "startRecording" },
  { type: "finishRecording", elapsed: 0 },
  { type: "finishRecording", elapsed: 5 },
  { type: "cancelRecording" },
  { type: "beginTranscription", id: "a", reachable: true, base64Chars: 1000, hasSession: true },
  { type: "beginTranscription", id: "b", reachable: false, base64Chars: 1000, hasSession: true },
  {
    type: "beginTranscription",
    id: "a",
    reachable: true,
    base64Chars: CONSTANTS.maxBase64Characters + 1,
    hasSession: true,
  },
  { type: "beginTranscription", id: "a", reachable: true, base64Chars: 1000, hasSession: false },
  { type: "messageErrored", id: "a" },
  { type: "messageErrored", id: "b" },
  { type: "transcript", id: "a", ok: true, text: "hi" },
  { type: "transcript", id: "b", ok: false },
  { type: "transcriptTimeout" },
  { type: "confirmSend", text: "typed" },
  { type: "quickReply", text: "a" },
  { type: "promptResult", id: "a", ok: true },
  { type: "promptResult", id: "b", ok: false },
  { type: "sentReset" },
  { type: "goHome" },
  { type: "typed", text: "typed" },
];

describe("model-based invariants", () => {
  it("holds for seeded sequences up to length 5", () => {
    const random = mulberry32(0xc0ffee);
    const pick = <T,>(items: readonly T[]): T =>
      items[Math.floor(random() * items.length)] as T;

    for (let sequence = 0; sequence < 400; sequence += 1) {
      const length = Math.floor(random() * 6); // 0..5
      let state: VoiceState = { step: "idle" };
      let prev: VoiceState = state;
      let event: VoiceEvent | null = null;

      for (let index = 0; index < length; index += 1) {
        event = pick(GENERATOR);
        prev = state;
        state = reduce(Object.freeze(state), event);

        // transcribing always carries the clip and a live timer
        if (state.step === "transcribing") {
          expect(state.path).toBeDefined();
          expect(state.pendingAudioId).toBeTruthy();
          expect(timerFor(state)).not.toBeNull();
        }
        // idle, error and confirm never carry a clip
        if (state.step === "idle" || state.step === "error" || state.step === "confirm") {
          expect(state.pendingAudioId).toBeUndefined();
        }
        // awaitingSentAck only exists while showing Sent
        if (state.awaitingSentAck) expect(state.step).toBe("sent");
        // Sent is entered only by confirming a transcript
        if (state.step === "sent" && prev.step !== "sent") {
          expect(prev.step).toBe("confirm");
          expect(event?.type).toBe("confirmSend");
        }
        // goHome always lands idle
        expect(reduce(state, { type: "goHome" }).step).toBe("idle");
      }
    }
  });
});

// ---- Swift drift: PhoneLink.swift must agree with the model ----

const SWIFT_SOURCE = fs.readFileSync(
  path.join(__dirname, "..", "targets", "watch", "PhoneLink.swift"),
  "utf8",
);

function swiftEnumCases(): string[] {
  const block = /enum VoiceStep: Equatable \{([\s\S]*?)\n\}/.exec(SWIFT_SOURCE)?.[1] ?? "";
  return [...block.matchAll(/case\s+([A-Za-z]+)/g)].map((match) => match[1] as string);
}

function swiftConstant(name: string): number | null {
  const match = new RegExp(`static let ${name}[^=]*=\\s*([\\d_.]+)`).exec(SWIFT_SOURCE);
  return match ? Number((match[1] as string).replace(/_/g, "")) : null;
}

function swiftTimerSeconds(after: string): number | null {
  const block = new RegExp(`(?:func ${after}|${after})[\\s\\S]{0,400}?withTimeInterval:\\s*([\\d.]+)`).exec(
    SWIFT_SOURCE,
  );
  return block ? Number(block[1]) : null;
}

describe("Swift drift: PhoneLink.swift vs the model", () => {
  it("(a) the VoiceStep cases equal VOICE_STATES", () => {
    expect(swiftEnumCases()).toEqual([...VOICE_STATES]);
  });

  it("(b) messageTimeoutSeconds matches the transcript timer", () => {
    expect(swiftConstant("messageTimeoutSeconds")).toBe(CONSTANTS.messageTimeoutSeconds);
    expect(swiftConstant("fileTransferTimeoutSeconds")).toBe(CONSTANTS.fileTransferTimeoutSeconds);
    expect(swiftConstant("maxBase64Characters")).toBe(CONSTANTS.maxBase64Characters);
  });

  it("(b) sentResetSeconds matches the sent reset timer", () => {
    expect(swiftTimerSeconds("scheduleSentReset")).toBe(CONSTANTS.sentResetSeconds);
  });

  it("(c) the transcript timeout error tells the user the Mac did not answer", () => {
    const start = SWIFT_SOURCE.indexOf("func startTranscriptTimer");
    const body = start >= 0 ? SWIFT_SOURCE.slice(start, start + 600) : "";
    expect(body).toMatch(/answer/i);
    expect(body).toMatch(/try again/i);
  });
});

// ---- timing: the watch must outlast the phone's own transcription deadline ----

describe("timing vs the phone's transcription deadline", () => {
  // src/voice.ts passes no explicit rpc timeout, so the phone's deadline is
  // RelayClient.rpc's default 60 s (src/relay/client.ts, rpcTimeoutMs 60_000).
  const phoneDeadlineSeconds = 60;

  it("documents today's numbers", () => {
    expect(phoneDeadlineSeconds).toBe(60);
    expect(CONSTANTS.messageTimeoutSeconds).toBe(63);
    expect(phoneDeadlineSeconds + 3).toBe(63);
  });

  it(
    "the watch outlasts the phone's deadline plus 3 s",
    () => {
      expect(CONSTANTS.messageTimeoutSeconds).toBeGreaterThanOrEqual(phoneDeadlineSeconds + 3);
    },
  );
});
