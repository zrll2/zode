import { DemoClient } from "../src/demo/DemoClient";
import { RelayClient } from "../src/relay/client";
import {
  MAX_RECORDING_SECONDS,
  buildVoiceHint,
  createVoiceController,
  transcribeClip,
  voiceErrorText,
  type VoiceRecorder,
  type VoiceSnapshot,
} from "../src/voice";

jest.mock("expo-audio", () => ({
  useAudioRecorder: () => ({
    prepare: async () => {},
    record: async () => {},
    stop: async () => {},
    uri: null,
    cancel: () => {},
  }),
  RecordingPresets: { HIGH_QUALITY: {} },
  AudioModule: { requestRecordingPermissionsAsync: async () => ({ granted: true }) },
}));

jest.mock("expo-file-system", () => ({
  File: class {},
}));

describe("voiceErrorText", () => {
  it("maps every relay reason to a plain sentence", () => {
    expect(voiceErrorText("no-model")).toBe(
      "Your Mac has not downloaded the voice model yet. Open Zode on the Mac, Settings, Voice.",
    );
    expect(voiceErrorText("busy")).toBe("Voice is busy, try again in a moment.");
    expect(voiceErrorText("rate-limited")).toBe("Voice is busy, try again in a moment.");
    expect(voiceErrorText("too-long")).toBe("That recording is too long. Keep it under a minute.");
    expect(voiceErrorText("too-large")).toBe("That recording is too long. Keep it under a minute.");
    expect(voiceErrorText("voice-off")).toBe(
      "Voice is not available on your Mac. Update Zode on the Mac.",
    );
    expect(voiceErrorText("no-engine")).toBe(
      "Voice is not available on your Mac. Update Zode on the Mac.",
    );
    expect(voiceErrorText("timeout")).toBe("Could not turn that into text. Try again.");
    expect(voiceErrorText("")).toBe("Could not turn that into text. Try again.");
  });
});

describe("transcribeClip", () => {
  const base = { base64: "AA==", format: "m4a" as const };

  it("returns the trimmed text", async () => {
    const rpc = jest.fn().mockResolvedValue({ ok: true, text: "  hello world  " });
    await expect(transcribeClip({ rpc, ...base })).resolves.toEqual({ ok: true, text: "hello world" });
    expect(rpc).toHaveBeenCalledWith("stt/transcribe", { audio: "AA==", format: "m4a" });
  });

  it("passes language and hint only when given", async () => {
    const rpc = jest.fn().mockResolvedValue({ ok: true, text: "x" });
    await transcribeClip({ rpc, ...base, language: "zh", hint: { projects: ["shop-api"] } });
    expect(rpc).toHaveBeenCalledWith("stt/transcribe", {
      audio: "AA==",
      format: "m4a",
      language: "zh",
      hint: { projects: ["shop-api"] },
    });
  });

  it.each([
    ["no-model", "Your Mac has not downloaded the voice model yet. Open Zode on the Mac, Settings, Voice."],
    ["busy", "Voice is busy, try again in a moment."],
    ["rate-limited", "Voice is busy, try again in a moment."],
    ["too-long", "That recording is too long. Keep it under a minute."],
    ["too-large", "That recording is too long. Keep it under a minute."],
    ["voice-off", "Voice is not available on your Mac. Update Zode on the Mac."],
    ["no-engine", "Voice is not available on your Mac. Update Zode on the Mac."],
    ["timeout", "Could not turn that into text. Try again."],
  ])("maps %s to a calm message", async (reason, expected) => {
    const rpc = jest.fn().mockRejectedValue({ reason });
    await expect(transcribeClip({ rpc, ...base })).resolves.toEqual({
      ok: false,
      message: expected,
    });
  });

  it("reads the reason out of a flattened error message", async () => {
    const rpc = jest.fn().mockRejectedValue(new Error("stt failed: busy"));
    await expect(transcribeClip({ rpc, ...base })).resolves.toEqual({
      ok: false,
      message: "Voice is busy, try again in a moment.",
    });
  });

  it("never throws", async () => {
    const rejecting = jest.fn().mockRejectedValue(undefined);
    await expect(transcribeClip({ rpc: rejecting, ...base })).resolves.toEqual({
      ok: false,
      message: "Could not turn that into text. Try again.",
    });
    const throwing = jest.fn().mockImplementation(() => {
      throw new Error("sync boom");
    });
    await expect(transcribeClip({ rpc: throwing, ...base })).resolves.toMatchObject({ ok: false });
  });

  it("treats an empty text as a failure", async () => {
    const rpc = jest.fn().mockResolvedValue({ ok: true, text: "   " });
    await expect(transcribeClip({ rpc, ...base })).resolves.toEqual({
      ok: false,
      message: "Could not turn that into text. Try again.",
    });
  });
});

describe("buildVoiceHint", () => {
  it("collects distinct projects and up to 20 titles", () => {
    const rows = Array.from({ length: 25 }, (_, index) => ({
      title: `Task ${index}`,
      folder: index % 2 === 0 ? "shop-api" : "web-app",
    }));
    const hint = buildVoiceHint(rows);
    expect(hint?.projects).toEqual(["shop-api", "web-app"]);
    expect(hint?.titles).toHaveLength(20);
  });

  it("returns undefined without usable rows", () => {
    expect(buildVoiceHint([])).toBeUndefined();
    expect(buildVoiceHint([{ title: "", folder: "" }])).toBeUndefined();
  });

  it("stays under the 2 KB budget", () => {
    const rows = Array.from({ length: 120 }, (_, index) => ({
      title: `Fix issue number ${index} with a long tail of detail words`.repeat(2),
      folder: `project-folder-${index}`,
    }));
    const hint = buildVoiceHint(rows);
    expect(hint).toBeDefined();
    expect(JSON.stringify(hint).length).toBeLessThanOrEqual(2048);
  });
});

// ---- the state machine (controller with injected fakes) ----

const flush = async () => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

function fakeRecorder() {
  const calls: string[] = [];
  let uriValue: string | null = "file:///tmp/clip.m4a";
  const recorder: VoiceRecorder = {
    prepare: async () => {
      calls.push("prepare");
    },
    start: async () => {
      calls.push("start");
    },
    stop: async () => {
      calls.push("stop");
    },
    uri: async () => {
      calls.push("uri");
      return uriValue;
    },
    reset: () => {
      calls.push("reset");
    },
  };
  return { calls, recorder, setUri: (value: string | null) => (uriValue = value) };
}

interface Overrides {
  available?: boolean;
  rpc?: jest.Mock;
  onText?: (text: string) => void;
  requestPermission?: () => Promise<boolean>;
  readAudio?: (uri: string) => Promise<{ base64: string; format: "m4a" }>;
  recorder?: VoiceRecorder;
  hint?: { projects?: string[]; titles?: string[] };
}

function makeController(overrides: Overrides = {}) {
  const fake = fakeRecorder();
  const rpc = overrides.rpc ?? jest.fn();
  const onText = overrides.onText ?? jest.fn();
  let available = overrides.available ?? true;
  const controller = createVoiceController({
    getAvailable: () => available,
    getRpc: () => rpc as any,
    getHint: () => overrides.hint,
    getLanguage: () => undefined,
    getOnText: () => onText,
    getRecorder: () => overrides.recorder ?? fake.recorder,
    getRequestPermission: () => overrides.requestPermission ?? (async () => true),
    getReadAudio: () =>
      overrides.readAudio ?? (async () => ({ base64: "QUJD", format: "m4a" as const })),
  });
  return { controller, fake, rpc, onText, setAvailable: (value: boolean) => (available = value) };
}

describe("voice controller state machine", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("records, transcribes, and hands the text over", async () => {
    const rpc = jest.fn().mockResolvedValue({ ok: true, text: "  hello world  " });
    const onText = jest.fn();
    const { controller, fake } = makeController({ rpc, onText });
    const snapshots: VoiceSnapshot[] = [];
    controller.subscribe((snapshot) => snapshots.push(snapshot));

    controller.start();
    await flush();
    expect(fake.calls).toEqual(["prepare", "start"]);
    expect(controller.getSnapshot().state).toBe("recording");
    expect(controller.getSnapshot().error).toBeNull();

    jest.advanceTimersByTime(7_000);
    expect(controller.getSnapshot().seconds).toBe(7);

    controller.stop();
    await flush();
    expect(fake.calls).toEqual(["prepare", "start", "stop", "uri", "reset"]);
    expect(rpc).toHaveBeenCalledWith("stt/transcribe", { audio: "QUJD", format: "m4a" });
    expect(onText).toHaveBeenCalledWith("hello world");
    expect(controller.getSnapshot().state).toBe("idle");
    expect(controller.getSnapshot().seconds).toBe(0);
    expect(controller.getSnapshot().error).toBeNull();
    expect(snapshots.some((snapshot) => snapshot.state === "transcribing")).toBe(true);
  });

  it("explains a denied microphone permission", async () => {
    const { controller, fake, rpc } = makeController({
      requestPermission: async () => false,
    });
    controller.start();
    await flush();
    expect(controller.getSnapshot().state).toBe("idle");
    expect(controller.getSnapshot().error).toBe(
      "Allow the microphone for Zode in Settings to use voice.",
    );
    expect(fake.calls).toEqual([]);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("stops by itself at 55 seconds and transcribes", async () => {
    const rpc = jest.fn().mockResolvedValue({ ok: true, text: "done" });
    const { controller } = makeController({ rpc });
    controller.start();
    await flush();

    jest.advanceTimersByTime((MAX_RECORDING_SECONDS - 1) * 1000);
    expect(controller.getSnapshot().state).toBe("recording");
    jest.advanceTimersByTime(1_000);
    await flush();

    expect(controller.getSnapshot().state).toBe("idle");
    expect(rpc).toHaveBeenCalled();
  });

  it("cancel discards the clip without transcribing", async () => {
    const rpc = jest.fn();
    const { controller, fake } = makeController({ rpc });
    controller.start();
    await flush();
    controller.cancel();
    await flush();
    expect(rpc).not.toHaveBeenCalled();
    expect(controller.getSnapshot().state).toBe("idle");
    expect(fake.calls).toContain("reset");
    expect(controller.getSnapshot().error).toBeNull();
  });

  it("maps relay failure reasons to calm messages", async () => {
    const rpc = jest.fn().mockRejectedValue({ reason: "busy" });
    const { controller } = makeController({ rpc });
    controller.start();
    await flush();
    controller.stop();
    await flush();
    expect(controller.getSnapshot().error).toBe("Voice is busy, try again in a moment.");
    expect(controller.getSnapshot().state).toBe("idle");
  });

  it("stays calm when reading the clip fails", async () => {
    const { controller } = makeController({
      readAudio: async () => {
        throw new Error("boom");
      },
    });
    controller.start();
    await flush();
    controller.stop();
    await flush();
    expect(controller.getSnapshot().error).toBe("Could not turn that into text. Try again.");
  });

  it("does nothing while voice is unavailable", async () => {
    const { controller, fake } = makeController({ available: false });
    controller.start();
    await flush();
    expect(fake.calls).toEqual([]);
    expect(controller.getSnapshot().state).toBe("idle");
  });

  it("passes the hint and language through to the rpc", async () => {
    const rpc = jest.fn().mockResolvedValue({ ok: true, text: "ok" });
    const { controller } = makeController({
      rpc,
      hint: { projects: ["shop-api"] },
      // language deliberately unset: omitted from the params
    });
    controller.start();
    await flush();
    controller.stop();
    await flush();
    expect(rpc).toHaveBeenCalledWith("stt/transcribe", {
      audio: "QUJD",
      format: "m4a",
      hint: { projects: ["shop-api"] },
    });
  });
});

// ---- the feature gate from the ready frame ----

class FakeSocket {
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code?: number }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  open() {
    this.onopen?.();
  }
  receive(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  drop(code = 1006) {
    this.onclose?.({ code });
  }
  send() {}
  close() {}
}

describe("ready.features gate", () => {
  it("exposes features.stt from the ready frame", async () => {
    const sockets: FakeSocket[] = [];
    const client = new RelayClient({
      url: "ws://relay.test:8787",
      token: "tok",
      createSocket: (url) => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket as any;
      },
    });
    const connected = client.connect();
    sockets[0]!.open();
    sockets[0]!.receive({ type: "ready", device: "mac", servers: [], seq: 1, features: { stt: true } });
    await connected;
    expect(client.relayFeatures).toEqual({ stt: true });

    sockets[0]!.drop(1006); // disconnect resets to unavailable
    expect(client.relayFeatures).toEqual({ stt: false });
    client.close();
  });

  it("defaults to unavailable when the relay is older", async () => {
    const sockets: FakeSocket[] = [];
    const client = new RelayClient({
      url: "ws://relay.test:8787",
      token: "tok",
      createSocket: (url) => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket as any;
      },
    });
    const connected = client.connect();
    sockets[0]!.open();
    sockets[0]!.receive({ type: "ready", device: "mac", servers: [], seq: 1 });
    await connected;
    expect(client.relayFeatures).toEqual({ stt: false });
    client.close();
  });

  it("the demo relay offers voice", () => {
    expect(new DemoClient().relayFeatures).toEqual({ stt: true });
  });
});
