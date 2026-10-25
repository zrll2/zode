import {
  buildPromptReply,
  buildTranscriptReply,
  parseWatchAudio,
  parseWatchPrompt,
  phoneUnreachableText,
  pickDefaultSession,
  promptFailureText,
  voiceUnavailableText,
} from "../src/watchVoice";

describe("pickDefaultSession", () => {
  it("prefers the first needs-you row", () => {
    const rows = [
      { id: "idle", project: "web", title: "Idle", state: "idle", updatedAt: 900 },
      { id: "needs", project: "api", title: "Needs you", state: "needs", updatedAt: 100 },
    ];
    expect(pickDefaultSession(rows)?.id).toBe("needs");
  });

  it("falls back to the most recent row", () => {
    const rows = [
      { id: "older", project: "web", title: "Older", state: "idle", updatedAt: 500 },
      { id: "newer", project: "web", title: "Newer", state: "working", updatedAt: 800 },
    ];
    expect(pickDefaultSession(rows)?.id).toBe("newer");
  });

  it("ignores junk and returns null for nothing usable", () => {
    expect(
      pickDefaultSession([null, 3, "x", {}, { project: "no id" }, { id: "" }]),
    ).toBeNull();
    expect(pickDefaultSession(undefined)).toBeNull();
    expect(pickDefaultSession("rows")).toBeNull();
  });
});

describe("parseWatchAudio", () => {
  it("accepts m4a and wav with ids", () => {
    expect(parseWatchAudio({ id: "a1", sessionId: "sess_1", format: "m4a" })).toEqual({
      id: "a1",
      sessionId: "sess_1",
      format: "m4a",
    });
    expect(parseWatchAudio({ id: "a2", sessionId: "sess_1", format: "wav" })).toMatchObject({
      format: "wav",
    });
  });

  it("rejects wrong formats, missing fields, and junk", () => {
    expect(parseWatchAudio({ id: "a", sessionId: "s", format: "mp3" })).toBeNull();
    expect(parseWatchAudio({ id: "a", format: "m4a" })).toBeNull();
    expect(parseWatchAudio({ sessionId: "s", format: "m4a" })).toBeNull();
    expect(parseWatchAudio(null)).toBeNull();
    expect(parseWatchAudio("clip")).toBeNull();
    expect(parseWatchAudio(undefined)).toBeNull();
  });

  it("enforces the 3 MB size cap when the size is known", () => {
    const meta = { id: "a", sessionId: "s", format: "m4a" };
    expect(parseWatchAudio(meta, 2 * 1024 * 1024)).not.toBeNull();
    expect(parseWatchAudio(meta, 3 * 1024 * 1024 + 1)).toBeNull();
    expect(parseWatchAudio(meta, undefined)).not.toBeNull();
    expect(parseWatchAudio(meta, "big")).not.toBeNull();
  });

  it("accepts audioBase64 inside the message (W3)", () => {
    expect(
      parseWatchAudio({ id: "a", sessionId: "s", format: "m4a", audioBase64: "QUJD" }),
    ).toEqual({ id: "a", sessionId: "s", format: "m4a", audioBase64: "QUJD" });
    expect(
      parseWatchAudio({ id: "a", sessionId: "s", format: "wav", audioBase64: "QQ==" }),
    ).toMatchObject({ format: "wav", audioBase64: "QQ==" });
  });

  it("rejects audioBase64 past the 3 MB decoded cap", () => {
    const meta = { id: "a", sessionId: "s", format: "m4a" };
    const fits = "A".repeat(4_194_300); // ~3 145 725 decoded bytes, just under
    const tooBig = "A".repeat(4_194_308); // ~3 145 731 decoded bytes, just over
    expect(parseWatchAudio({ ...meta, audioBase64: fits })).not.toBeNull();
    expect(parseWatchAudio({ ...meta, audioBase64: tooBig })).toBeNull();
  });

  it("rejects bad audioBase64 payloads", () => {
    const meta = { id: "a", sessionId: "s", format: "m4a" };
    expect(parseWatchAudio({ ...meta, audioBase64: "" })).toBeNull();
    expect(parseWatchAudio({ ...meta, audioBase64: 42 })).toEqual({
      id: "a",
      sessionId: "s",
      format: "m4a",
    });
    expect(
      parseWatchAudio({ id: "a", sessionId: "s", format: "mp3", audioBase64: "QUJD" }),
    ).toBeNull();
    expect(parseWatchAudio({ sessionId: "s", format: "m4a", audioBase64: "QUJD" })).toBeNull();
  });
});

describe("parseWatchPrompt", () => {
  it("trims the text", () => {
    expect(parseWatchPrompt({ id: "p1", sessionId: "s1", text: "  Continue  " })).toEqual({
      id: "p1",
      sessionId: "s1",
      text: "Continue",
    });
  });

  it("rejects empty text, missing fields, and junk", () => {
    expect(parseWatchPrompt({ id: "p1", sessionId: "s1", text: "   " })).toBeNull();
    expect(parseWatchPrompt({ sessionId: "s1", text: "hi" })).toBeNull();
    expect(parseWatchPrompt({ id: "p1", text: "hi" })).toBeNull();
    expect(parseWatchPrompt(null)).toBeNull();
    expect(parseWatchPrompt(7)).toBeNull();
  });
});

describe("reply builders", () => {
  it("builds transcript replies", () => {
    expect(buildTranscriptReply("a1", { ok: true, text: "hello there" })).toEqual({
      type: "transcript",
      id: "a1",
      ok: true,
      text: "hello there",
    });
    expect(
      buildTranscriptReply("a1", { ok: false, message: voiceUnavailableText() }),
    ).toEqual({
      type: "transcript",
      id: "a1",
      ok: false,
      message: "Voice is not available on your Mac. Update Zode on the Mac.",
    });
  });

  it("builds result replies", () => {
    expect(buildPromptReply("p1", true)).toEqual({ type: "result", id: "p1", ok: true });
    expect(buildPromptReply("p1", false, "Nope.")).toEqual({
      type: "result",
      id: "p1",
      ok: false,
      message: "Nope.",
    });
    expect(buildPromptReply("p1", false).message).toBe(phoneUnreachableText());
    expect(phoneUnreachableText()).toBe("Your phone cannot reach your Mac.");
  });

  it("maps send failures through the friendly error path", () => {
    const unreachable = promptFailureText(new Error("relay: not connected (closed)"));
    expect(unreachable).toContain("Can't reach your Mac");
    expect(promptFailureText(new Error("boom"))).toBe("boom");
  });
});

describe("watch ids", () => {
  it("prefers rid: the phone's watch library replaces id on incoming messages", () => {
    expect(
      parseWatchAudio({ id: "lib-guid", rid: "clip-1", sessionId: "s", format: "m4a", audioBase64: "QUJD" })?.id,
    ).toBe("clip-1");
    expect(parseWatchPrompt({ id: "lib-guid", rid: "p-1", sessionId: "s", text: "Yes" })?.id).toBe("p-1");
    expect(parseWatchPrompt({ id: "only", sessionId: "s", text: "Yes" })?.id).toBe("only");
  });
});
