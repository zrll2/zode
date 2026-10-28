import { RelayClient, type RelayStatus, type SocketFactory } from "../src/relay/client";

class MockSocket {
  url: string;
  sent: any[] = [];
  closed: Array<number | undefined> = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  constructor(url: string) {
    this.url = url;
  }

  send(data: string) {
    this.sent.push(JSON.parse(data));
  }

  close(code?: number, _reason?: string) {
    this.closed.push(code);
  }

  open() {
    this.onopen?.();
  }

  receive(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  drop(code = 1006) {
    this.onclose?.({ code });
  }
}

function makeClient() {
  const sockets: MockSocket[] = [];
  const factory: SocketFactory = (url) => {
    const socket = new MockSocket(url);
    sockets.push(socket);
    return socket as any;
  };
  const client = new RelayClient({ url: "ws://relay.test:8787", token: "tok", createSocket: factory });
  return { client, sockets };
}

function makeMultiClient(urls: string[], preferred?: string) {
  const sockets: MockSocket[] = [];
  const factory: SocketFactory = (url) => {
    const socket = new MockSocket(url);
    sockets.push(socket);
    return socket as any;
  };
  const client = new RelayClient({
    url: urls[0] ?? "ws://relay.test:8787",
    urls,
    preferred,
    token: "tok",
    createSocket: factory,
  });
  const byUrl = (url: string) => sockets.find((socket) => socket.url === url);
  return { client, sockets, byUrl };
}

const READY = { type: "ready", device: "mac", servers: [{ pid: 1, cwd: "/tmp/proj" }], seq: 3 };

afterEach(() => {
  jest.useRealTimers();
});

it("sends auth first and resolves connect on ready", async () => {
  const { client, sockets } = makeClient();
  const connecting: RelayClient["status"][] = [];
  client.onStatus((s) => connecting.push(s));
  const connected = client.connect();
  expect(sockets).toHaveLength(1);
  sockets[0].open();
  expect(sockets[0].sent[0]).toEqual({ type: "auth", token: "tok" });
  expect(sockets[0].sent[0]).not.toHaveProperty("since");
  sockets[0].receive(READY);
  await connected;
  expect(client.status).toBe("ready");
  expect(client.servers).toEqual([{ pid: 1, cwd: "/tmp/proj" }]);
  client.close();
});

it("parses ready.features into stt and push, defaulting to false", async () => {
  const { client, sockets } = makeClient();
  const connected = client.connect();
  sockets[0].open();
  sockets[0].receive({ type: "ready", device: "mac", servers: [], seq: 1, features: { stt: true, push: true } });
  await connected;
  expect(client.relayFeatures).toEqual({ stt: true, push: true });
  client.close();
});

it("treats a missing push feature as false while keeping stt", async () => {
  const { client, sockets } = makeClient();
  const connected = client.connect();
  sockets[0].open();
  sockets[0].receive({ type: "ready", device: "mac", servers: [], seq: 1, features: { stt: true } });
  await connected;
  expect(client.relayFeatures).toEqual({ stt: true, push: false });

  // an older relay re-sends ready without a features object
  sockets[0].receive({ type: "ready", device: "mac", servers: [], seq: 2 });
  expect(client.relayFeatures).toEqual({ stt: false, push: false });
  client.close();
});

it("matches rpc results by id and rejects on error", async () => {
  const { client, sockets } = makeClient();
  const connected = client.connect();
  sockets[0].open();
  sockets[0].receive(READY);
  await connected;

  const list = client.rpc<any>("session/list", {});
  const listFrame = sockets[0].sent.find((f) => f.type === "rpc");
  sockets[0].receive({ type: "rpc-result", id: listFrame.id, result: { sessions: [1] } });
  await expect(list).resolves.toEqual({ sessions: [1] });

  const create = client.rpc("session/create", {});
  const createFrame = sockets[0].sent[sockets[0].sent.length - 1];
  expect(createFrame.method).toBe("session/create");
  sockets[0].receive({ type: "rpc-result", id: createFrame.id, error: "no ZCode server" });
  await expect(create).rejects.toThrow("no ZCode server");

  // unknown ids are ignored
  sockets[0].receive({ type: "rpc-result", id: "nope", result: null });
  client.close();
});

it("rejects an rpc after the timeout", async () => {
  jest.useFakeTimers();
  const { client, sockets } = makeClient();
  const connected = client.connect();
  sockets[0].open();
  sockets[0].receive(READY);
  await connected;

  const pending = client.rpc("session/list", {});
  const assertion = expect(pending).rejects.toThrow("timed out");
  jest.advanceTimersByTime(60_000);
  await assertion;
  client.close();
});

it("backs off when a live connection drops and resumes with since", async () => {
  jest.useFakeTimers();
  const { client, sockets } = makeClient();
  const connected = client.connect();
  sockets[0].open();
  sockets[0].receive(READY);
  await connected;

  sockets[0].receive({
    type: "event",
    seq: 7,
    server: "srv",
    msg: { method: "session/event", params: { type: "turn.started", payload: { input: "hi" } } },
  });

  // a live drop joins the backoff loop instead of re-racing at once
  sockets[0].drop(1006);
  expect(client.status).toBe("reconnecting");
  expect(sockets).toHaveLength(1);

  jest.advanceTimersByTime(2_000); // the first delay is at most 1150 ms
  expect(sockets).toHaveLength(2);
  sockets[1].open();
  expect(sockets[1].sent[0]).toEqual({ type: "auth", token: "tok", since: 7 });

  sockets[1].receive({ ...READY, seq: 8 });
  expect(client.status).toBe("ready");
  client.close();
});

it("climbs the backoff while the connection flaps without settling", async () => {
  jest.useFakeTimers();
  const { client, sockets } = makeClient();
  const connected = client.connect();
  connected.catch(() => {});
  sockets[0].open();
  sockets[0].receive(READY);
  await connected;

  // two quick ready-then-drop cycles: attempts 0 then 1
  sockets[0].drop(1006);
  jest.advanceTimersByTime(2_000);
  sockets[1].open();
  sockets[1].receive({ ...READY, seq: 8 });
  sockets[1].drop(1006);

  // the second delay is 1700-2300 ms: the counter did not restart
  jest.advanceTimersByTime(1_600);
  expect(sockets).toHaveLength(2);
  jest.advanceTimersByTime(1_000);
  expect(sockets).toHaveLength(3);
  client.close();
});

it("restarts the backoff after a connection stayed up ten seconds", async () => {
  jest.useFakeTimers();
  const { client, sockets } = makeClient();
  const connected = client.connect();
  connected.catch(() => {});
  sockets[0].open();
  sockets[0].receive(READY);
  await connected;

  sockets[0].drop(1006);
  jest.advanceTimersByTime(2_000);
  sockets[1].open();
  sockets[1].receive({ ...READY, seq: 8 });

  // stay up well past the stability window, then drop again
  jest.advanceTimersByTime(20_000);
  sockets[1].drop(1006);

  // the counter reset, so the next delay is short again (at most 1150 ms)
  jest.advanceTimersByTime(2_000);
  expect(sockets).toHaveLength(3);
  client.close();
});

it("ignores a stale ready from a socket that lost the race", async () => {
  jest.useFakeTimers();
  const { client, byUrl } = makeMultiClient(["ws://a:1", "ws://b:2"]);
  const connectedUrls: string[] = [];
  client.onConnected((url) => connectedUrls.push(url));
  const connected = client.connect();

  const a = byUrl("ws://a:1")!;
  a.open();
  jest.advanceTimersByTime(2_500);
  const b = byUrl("ws://b:2")!;
  b.open();

  a.receive(READY);
  await connected;
  b.receive(READY); // already in flight when b lost: must change nothing

  expect(client.status).toBe("ready");
  expect(connectedUrls).toEqual(["ws://a:1"]);
  expect(client.candidateUrls).toEqual(["ws://a:1", "ws://b:2"]);

  // the real winner is still the socket rpc rides on
  const listing = client.rpc("session/list", {});
  expect(a.sent.some((f) => f.type === "rpc")).toBe(true);
  client.close();
  await expect(listing).rejects.toThrow("relay: closed");
});

it("falls back to backoff when a round fails without ready", async () => {
  jest.useFakeTimers();
  const { client, sockets } = makeClient();
  const connected = client.connect();
  sockets[0].open();
  sockets[0].drop(1006); // never reached ready

  expect(client.status).toBe("reconnecting");
  expect(sockets).toHaveLength(1);

  // first delay is jittered: 850 ms at minimum, 1150 ms at most
  jest.advanceTimersByTime(800);
  expect(sockets).toHaveLength(1);
  jest.advanceTimersByTime(400);
  expect(sockets).toHaveLength(2);

  sockets[1].open();
  sockets[1].receive(READY);
  await connected;
  expect(client.status).toBe("ready");
  client.close();
});

it("drops duplicate events (seq <= last seen)", async () => {
  const { client, sockets } = makeClient();
  const connected = client.connect();
  sockets[0].open();
  sockets[0].receive(READY);
  await connected;

  const seen: number[] = [];
  client.onEvent((_msg, seq) => seen.push(seq));

  const event = (seq: number) => ({
    type: "event",
    seq,
    server: "srv",
    msg: { method: "session/event", params: { type: "checkpoint.created", payload: {} } },
  });
  sockets[0].receive(event(5));
  sockets[0].receive(event(5));
  sockets[0].receive(event(4));
  sockets[0].receive(event(6));

  expect(seen).toEqual([5, 6]);
  client.close();
});

it("stops on close code 4003 and exposes authFailed", async () => {
  jest.useFakeTimers();
  const { client, sockets } = makeClient();
  const connected = client.connect();
  sockets[0].open();
  sockets[0].receive(READY);
  await connected;

  sockets[0].drop(4003);
  expect(client.status).toBe("closed");
  expect(client.authFailed).toBe(true);

  jest.advanceTimersByTime(120_000);
  expect(sockets).toHaveLength(1); // no reconnect attempts
  client.close();
});

it("replays buffered events to late subscribers", async () => {
  const { client, sockets } = makeClient();
  const connected = client.connect();
  sockets[0].open();
  sockets[0].receive(READY);
  await connected;

  sockets[0].receive({
    type: "event",
    seq: 9,
    server: "srv",
    msg: { method: "session/event", params: { type: "turn.started", payload: { input: "hi" } } },
  });

  const seen: number[] = [];
  client.onEvent((_msg, seq) => seen.push(seq));
  expect(seen).toEqual([9]);
  client.close();
});

it("exposes relayProtocol only once the relay announces it", async () => {
  const { client, sockets } = makeClient();
  const connected = client.connect();
  sockets[0].open();
  // Old relay: no protocol field in the ready frame.
  sockets[0].receive(READY);
  await connected;
  expect(client.relayProtocol).toBeUndefined();
  client.close();
});

it("remembers the announced protocol and resets it on disconnect", async () => {
  const { client, sockets } = makeClient();
  const connected = client.connect();
  sockets[0].open();
  sockets[0].receive({ ...READY, protocol: 2 });
  await connected;
  expect(client.relayProtocol).toBe(2);

  // a junk value is not a number, so it counts as "no protocol announced"
  sockets[0].receive({ ...READY, protocol: "2" });
  expect(client.relayProtocol).toBeUndefined();

  sockets[0].drop(1006);
  expect(client.relayProtocol).toBeUndefined();
  client.close();
});

const READY_PENDING = {
  ...READY,
  pending: [
    {
      server: "srv-a",
      id: "p1",
      method: "interaction/requestPermission",
      params: {
        sessionId: "s1",
        toolName: "Bash",
        riskLevel: "high",
        input: { command: "rm -rf /tmp/x" },
      },
      at: 100,
    },
  ],
};

it("collects pending approvals from ready, new request events, and tap/resolved", async () => {
  const { client, sockets } = makeClient();
  const connected = client.connect();
  sockets[0].open();
  sockets[0].receive(READY_PENDING);
  await connected;
  expect(client.pendingApprovals.map((request) => request.key)).toEqual(["srv-a:p1"]);
  expect(client.pendingApprovals[0].risky).toBe(true);

  sockets[0].receive({
    type: "event",
    seq: 10,
    server: "srv-b",
    msg: {
      method: "interaction/requestPermission",
      id: "p2",
      params: { sessionId: "s1", toolName: "Edit", riskLevel: "low", input: { file_path: "/a/b.ts" } },
      at: 200,
    },
  });
  expect(client.pendingApprovals.map((request) => request.id)).toEqual(["p1", "p2"]);

  sockets[0].receive({
    type: "event",
    seq: 11,
    server: "srv-a",
    msg: { method: "tap/resolved", params: { id: "p1" } },
  });
  expect(client.pendingApprovals.map((request) => request.id)).toEqual(["p2"]);

  client.close();
  expect(client.pendingApprovals).toEqual([]);
});

it("respond resolves ok on success and with a message on failure", async () => {
  const { client, sockets } = makeClient();
  const connected = client.connect();
  sockets[0].open();
  sockets[0].receive(READY_PENDING);
  await connected;

  const ok = client.respond("srv-a", "p1", "allow");
  const frame = sockets[0].sent.find((f) => f.type === "respond");
  expect(frame).toMatchObject({ type: "respond", server: "srv-a", id: "p1", decision: "allow" });
  sockets[0].receive({ type: "rpc-result", id: frame.rid, result: {} });
  await expect(ok).resolves.toEqual({ ok: true });

  const lost = client.respond("srv-a", "p1", "deny");
  const frame2 = sockets[0].sent.filter((f) => f.type === "respond")[1];
  sockets[0].receive({
    type: "rpc-result",
    id: frame2.rid,
    error: "request is not pending (already answered?)",
  });
  const result = await lost;
  expect(result.ok).toBe(false);
  expect(result.message).toContain("not pending");
  client.close();
});

it("respond times out after 10 s and refuses when not connected", async () => {
  jest.useFakeTimers();
  const { client, sockets } = makeClient();
  const offline = await client.respond("srv-a", "p1", "allow");
  expect(offline.ok).toBe(false);

  const connected = client.connect();
  sockets[0].open();
  sockets[0].receive(READY_PENDING);
  await connected;

  const pending = client.respond("srv-a", "p1", "deny");
  const assertion = expect(pending).resolves.toEqual({
    ok: false,
    message: "Couldn't reach your Mac. Try again.",
  });
  jest.advanceTimersByTime(10_000);
  await assertion;
  client.close();
});

describe("address racing", () => {
  it("connects over the preferred address with a head start", async () => {
    jest.useFakeTimers();
    const { client, sockets } = makeMultiClient(
      ["ws://a:1", "ws://b:2", "ws://c:3"],
      "ws://b:2",
    );
    const seen: RelayStatus[] = [];
    client.onStatus((s) => seen.push(s));
    const connectedUrls: string[] = [];
    client.onConnected((url) => connectedUrls.push(url));

    const connected = client.connect();
    expect(sockets.map((socket) => socket.url)).toEqual(["ws://b:2"]); // head start
    const winner = sockets[0]!;
    winner.open();
    winner.receive({ ...READY, addresses: ["ws://b:2", "ws://a:1"] });
    await connected;

    expect(client.status).toBe("ready");
    expect(seen).toEqual(["connecting", "ready"]); // no flicker
    expect(connectedUrls).toEqual(["ws://b:2"]);
    jest.advanceTimersByTime(10_000);
    expect(sockets).toHaveLength(1); // the losers never open
    client.close();
  });

  it("moves on to the next address when the preferred one is dead", async () => {
    jest.useFakeTimers();
    const { client, sockets, byUrl } = makeMultiClient(["ws://a:1", "ws://b:2"], "ws://a:1");
    const connected = client.connect();

    const first = byUrl("ws://a:1")!;
    first.open();
    first.drop(1006); // dead before the head start ends
    expect(client.status).toBe("connecting"); // still racing, not backing off

    jest.advanceTimersByTime(2_500);
    const second = byUrl("ws://b:2")!;
    second.open();
    second.receive(READY);
    await connected;
    expect(client.status).toBe("ready");
    client.close();
  });

  it("closes losing sockets as soon as one address wins", async () => {
    jest.useFakeTimers();
    const { client, byUrl } = makeMultiClient(["ws://a:1", "ws://b:2"]);
    const seen: RelayStatus[] = [];
    client.onStatus((s) => seen.push(s));
    const connected = client.connect();

    const a = byUrl("ws://a:1")!;
    a.open();
    jest.advanceTimersByTime(2_500);
    const b = byUrl("ws://b:2")!;
    b.open();

    a.receive(READY);
    await connected;
    expect(b.closed).toEqual([1000]); // closed immediately, "lost race"

    b.drop(1006); // a loser's close event must change nothing
    expect(client.status).toBe("ready");
    expect(seen).toEqual(["connecting", "ready"]);
    client.close();
  });

  it("backs off only after every candidate has failed", async () => {
    jest.useFakeTimers();
    const { client, sockets, byUrl } = makeMultiClient(["ws://a:1", "ws://b:2"]);
    const connected = client.connect();

    byUrl("ws://a:1")!.drop(1006); // the second candidate is not open yet
    expect(client.status).toBe("connecting");

    jest.advanceTimersByTime(2_500);
    byUrl("ws://b:2")!.drop(1006);
    expect(client.status).toBe("reconnecting");

    jest.advanceTimersByTime(1_200);
    expect(sockets).toHaveLength(3); // round two starts over the first url
    sockets[2]!.open();
    sockets[2]!.receive(READY);
    await connected;
    client.close();
  });

  it("stops on a 4003 from any candidate", async () => {
    jest.useFakeTimers();
    const { client, sockets, byUrl } = makeMultiClient(["ws://a:1", "ws://b:2"]);
    const connected = client.connect();
    connected.catch(() => {});

    const a = byUrl("ws://a:1")!;
    a.open();
    a.drop(4003);
    expect(client.status).toBe("closed");
    expect(client.authFailed).toBe(true);

    jest.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1); // the other candidate never launched
    client.close();
  });

  it("learns the relay's address list from ready and prefers the winner", async () => {
    jest.useFakeTimers();
    const { client, sockets } = makeMultiClient(["ws://old:1"]);
    const addressesSeen: (string[] | null)[] = [];
    client.onConnected((_url, addresses) => addressesSeen.push(addresses));

    const connected = client.connect();
    sockets[0]!.open();
    sockets[0]!.receive({ ...READY, addresses: ["ws://n1:1", "ws://n2:2", "junk"] });
    await connected;

    expect(addressesSeen).toEqual([["ws://n1:1", "ws://n2:2", "ws://old:1"]]);
    expect(client.candidateUrls).toEqual(["ws://old:1", "ws://n1:1", "ws://n2:2"]);

    sockets[0]!.drop(1006); // the re-race tries the winner first
    jest.advanceTimersByTime(2_000); // past the first backoff delay
    const next = sockets[1]!;
    expect(next.url).toBe("ws://old:1");
    next.open();
    next.receive(READY);
    expect(client.status).toBe("ready");
    client.close();
  });
});
