import { parsePairingPayload, pair } from "../src/pairing";

const PAYLOAD_TEXT = '{"u":"ws://100.64.0.7:8787","w":"/Users/me/proj","c":"ABC123"}';

describe("parsePairingPayload", () => {
  it("parses a valid {u,w,c} payload", () => {
    expect(parsePairingPayload(PAYLOAD_TEXT)).toEqual({
      u: "ws://100.64.0.7:8787",
      w: "/Users/me/proj",
      c: "ABC123",
    });
  });

  it("tolerates surrounding whitespace", () => {
    expect(parsePairingPayload(`  \n${PAYLOAD_TEXT}\n `).c).toBe("ABC123");
  });

  it("rejects invalid JSON", () => {
    expect(() => parsePairingPayload("not json")).toThrow(/not valid JSON/i);
  });

  it("rejects missing fields", () => {
    expect(() => parsePairingPayload('{"u":"ws://x","w":"/p"}')).toThrow(/missing/);
  });

  it("rejects a non-ws url", () => {
    expect(() => parsePairingPayload('{"u":"ftp://x","w":"/p","c":"1"}')).toThrow(/ws:\/\//);
  });

  it("accepts an http url too", () => {
    const payload = parsePairingPayload('{"u":"https://relay.example","w":"/p","c":"1"}');
    expect(payload.u).toBe("https://relay.example");
  });

  it("parses text typed with iOS curly quotes", () => {
    const curly = "{“u”:“ws://100.64.0.7:8787”,“w”:“/Users/me/proj”,“c”:“C1”}";
    expect(parsePairingPayload(curly)).toEqual({
      u: "ws://100.64.0.7:8787",
      w: "/Users/me/proj",
      c: "C1",
    });
  });

  it("strips zero-width and non-breaking spaces", () => {
    const spaced = '{\u200B"u"\u00A0: "ws://a:1","w":"/p","c":"C3"\uFEFF}';
    expect(parsePairingPayload(spaced)).toEqual({
      u: "ws://a:1",
      w: "/p",
      c: "C3",
    });
  });

  it("finds the valid object after leftover garbage", () => {
    const messy = 'oops, forgot to clear the field\n{"u":"ws://a:1","w":"/p","c":"C2"}';
    expect(parsePairingPayload(messy)).toEqual({
      u: "ws://a:1",
      w: "/p",
      c: "C2",
    });
  });

  it("prefers the last valid object when the field holds two", () => {
    const two =
      '{"u":"ws://old:1","w":"/old","c":"OLD"} and later {"u":"ws://new:2","w":"/new","c":"NEW"}';
    expect(parsePairingPayload(two)).toEqual({
      u: "ws://new:2",
      w: "/new",
      c: "NEW",
    });
  });

  it("still throws on text with no usable object", () => {
    expect(() => parsePairingPayload("total garbage { not json")).toThrow(/not valid JSON/i);
  });
});

describe("pair", () => {
  const payload = parsePairingPayload(PAYLOAD_TEXT);

  it("posts the code to {u}/pair and returns credentials with a ws url", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: "dev_1", token: "tok_1" }),
    }) as any;

    const result = await pair(payload, "Test phone", fetchImpl);

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://100.64.0.7:8787/pair",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ code: "ABC123", name: "Test phone" }),
      }),
    );
    expect(result).toEqual({ id: "dev_1", token: "tok_1", wsUrl: "ws://100.64.0.7:8787" });
  });

  it("converts an http url to ws for the socket", async () => {
    const httpPayload = parsePairingPayload(
      '{"u":"https://relay.example:8787","w":"/p","c":"1"}',
    );
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: "dev_1", token: "tok_1" }),
    }) as any;

    const result = await pair(httpPayload, "Test phone", fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://relay.example:8787/pair",
      expect.anything(),
    );
    expect(result.wsUrl).toBe("wss://relay.example:8787");
  });

  it("surfaces the relay's error message", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: "Invalid pair code" }),
    }) as any;

    await expect(pair(payload, "Test phone", fetchImpl)).rejects.toThrow("Invalid pair code");
  });

  it("falls back to a generic message without a body", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error("no body");
      },
    }) as any;

    await expect(pair(payload, "Test phone", fetchImpl)).rejects.toThrow(/HTTP 500/);
  });
});
