import {
  describeAddress,
  parsePairingPayload,
  pair,
  webPairingPayload,
  webRelayFromLocation,
} from "../src/pairing";

const PAYLOAD_TEXT = '{"u":"ws://100.64.0.7:8787","w":"/Users/me/proj","c":"ABC123"}';

describe("parsePairingPayload", () => {
  it("parses a valid {u,w,c} payload", () => {
    expect(parsePairingPayload(PAYLOAD_TEXT)).toEqual({
      u: "ws://100.64.0.7:8787",
      urls: ["ws://100.64.0.7:8787"],
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
      urls: ["ws://100.64.0.7:8787"],
      w: "/Users/me/proj",
      c: "C1",
    });
  });

  it("strips zero-width and non-breaking spaces", () => {
    const spaced = '{\u200B"u"\u00A0: "ws://a:1","w":"/p","c":"C3"\uFEFF}';
    expect(parsePairingPayload(spaced)).toEqual({
      u: "ws://a:1",
      urls: ["ws://a:1"],
      w: "/p",
      c: "C3",
    });
  });

  it("finds the valid object after leftover garbage", () => {
    const messy = 'oops, forgot to clear the field\n{"u":"ws://a:1","w":"/p","c":"C2"}';
    expect(parsePairingPayload(messy)).toEqual({
      u: "ws://a:1",
      urls: ["ws://a:1"],
      w: "/p",
      c: "C2",
    });
  });

  it("prefers the last valid object when the field holds two", () => {
    const two =
      '{"u":"ws://old:1","w":"/old","c":"OLD"} and later {"u":"ws://new:2","w":"/new","c":"NEW"}';
    expect(parsePairingPayload(two)).toEqual({
      u: "ws://new:2",
      urls: ["ws://new:2"],
      w: "/new",
      c: "NEW",
    });
  });

  it("collects urls next to u, normalised, deduped, in order", () => {
    const payload = parsePairingPayload(
      '{"u":"ws://a:1","urls":["ws://b:2","ws://a:1","nope",42," http://c:3 "],"w":"/p","c":"C"}',
    );
    expect(payload.u).toBe("ws://a:1");
    expect(payload.urls).toEqual(["ws://a:1", "ws://b:2", "http://c:3"]);
  });

  it("caps the url list at six", () => {
    const payload = parsePairingPayload(
      '{"u":"ws://1:1","urls":["ws://2:1","ws://3:1","ws://4:1","ws://5:1","ws://6:1","ws://7:1"],"w":"/p","c":"C"}',
    );
    expect(payload.urls).toEqual([
      "ws://1:1",
      "ws://2:1",
      "ws://3:1",
      "ws://4:1",
      "ws://5:1",
      "ws://6:1",
    ]);
  });

  it("parses on urls alone when u is missing or unusable", () => {
    const noU = parsePairingPayload('{"urls":["ws://b:2","ws://c:3"],"w":"/p","c":"C"}');
    expect(noU.u).toBe("ws://b:2");
    expect(noU.urls).toEqual(["ws://b:2", "ws://c:3"]);
    const badU = parsePairingPayload('{"u":"ftp://x","urls":["ws://b:2"],"w":"/p","c":"C"}');
    expect(badU.u).toBe("ws://b:2");
  });

  it("still demands usable addresses", () => {
    expect(() =>
      parsePairingPayload('{"u":"ftp://x","urls":["nope"],"w":"/p","c":"C"}'),
    ).toThrow(/ws:\/\//);
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
    expect(result).toEqual({
      id: "dev_1",
      token: "tok_1",
      wsUrl: "ws://100.64.0.7:8787",
      wsUrls: ["ws://100.64.0.7:8787"],
    });
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

  it("pairs through the first working address", async () => {
    const multi = parsePairingPayload(
      '{"u":"ws://a:1","urls":["ws://a:1","ws://b:2"],"w":"/p","c":"C"}',
    );
    const fetchImpl = jest
      .fn()
      .mockRejectedValueOnce(new Error("network request failed"))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: "dev_1", token: "tok_1" }),
      }) as any;

    const result = await pair(multi, "Test phone", fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("http://a:1/pair");
    expect(fetchImpl.mock.calls[1]?.[0]).toBe("http://b:2/pair");
    expect(result).toEqual({
      id: "dev_1",
      token: "tok_1",
      wsUrl: "ws://b:2",
      wsUrls: ["ws://a:1", "ws://b:2"],
    });
  });

  it("reports the last error when every address fails", async () => {
    const multi = parsePairingPayload(
      '{"u":"ws://a:1","urls":["ws://a:1","ws://b:2"],"w":"/p","c":"C"}',
    );
    const fetchImpl = jest.fn().mockRejectedValue(new Error("host unreachable")) as any;

    await expect(pair(multi, "Test phone", fetchImpl)).rejects.toThrow("host unreachable");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("web pairing", () => {
  const loc = { protocol: "http:", host: "mac:8787" };

  it("derives ws and wss relay addresses from the page location", () => {
    expect(webRelayFromLocation(loc)).toEqual({
      u: "ws://mac:8787",
      urls: ["ws://mac:8787"],
    });
    expect(webRelayFromLocation({ protocol: "https:", host: "mac" }).u).toBe("wss://mac");
    expect(webRelayFromLocation({ protocol: "http:", host: "[::1]:8787" }).u).toBe(
      "ws://[::1]:8787",
    );
    expect(webRelayFromLocation({ protocol: "https:", host: "mac:8443" }).urls).toEqual([
      "wss://mac:8443",
    ]);
  });

  it("builds a payload for a bare pairing code", () => {
    expect(webPairingPayload("ABC123", loc)).toEqual({
      u: "ws://mac:8787",
      urls: ["ws://mac:8787"],
      w: "",
      c: "ABC123",
    });
    expect(webPairingPayload("  code_9 ", loc)?.c).toBe("code_9");
  });

  it("rejects bare codes that are not codes", () => {
    expect(webPairingPayload("", loc)).toBeNull();
    expect(webPairingPayload("has space", loc)).toBeNull();
    expect(webPairingPayload('{"u":"ws://x"}', loc)).toBeNull();
  });

  it("pairs a web payload through the derived http address", async () => {
    const payload = webPairingPayload("C1", { protocol: "http:", host: "mac:8787" })!;
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ id: "dev_1", token: "tok_1" }),
    })) as any;

    const result = await pair(payload, "Browser", fetchImpl);

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://mac:8787/pair",
      expect.objectContaining({ body: JSON.stringify({ code: "C1", name: "Browser" }) }),
    );
    expect(result.wsUrl).toBe("ws://mac:8787");
  });
});

describe("describeAddress", () => {
  it("names the network from the address host", () => {
    expect(describeAddress("ws://192.168.1.20:8787")).toBe("Connected over Wi-Fi");
    expect(describeAddress("ws://10.1.2.3:8787")).toBe("Connected over Wi-Fi");
    expect(describeAddress("wss://172.20.0.9:8787")).toBe("Connected over Wi-Fi");
    expect(describeAddress("ws://100.64.0.7:8787")).toBe("Connected over Tailscale");
    expect(describeAddress("ws://100.127.4.4:8787")).toBe("Connected over Tailscale");
  });

  it("stays neutral for anything else", () => {
    expect(describeAddress("ws://100.128.0.1:8787")).toBe("Connected");
    expect(describeAddress("ws://100.63.0.1:8787")).toBe("Connected");
    expect(describeAddress("ws://172.32.0.1:8787")).toBe("Connected");
    expect(describeAddress("wss://relay.example.com")).toBe("Connected");
    expect(describeAddress("")).toBe("Connected");
  });
});
