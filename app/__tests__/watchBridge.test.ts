import {
  buildWatchSnapshot,
  forwardableClip,
  nextPushDelayMs,
  sessionIsPushed,
  shouldFetch,
} from "../src/watchBridge";

// Nothing native may load: the bridge imports react-native-watch-connectivity
// lazily, but mock it anyway so an accidental eager import stays harmless.
// expo-file-system is mocked because the bridge reads received clips with it.
jest.mock("react-native-watch-connectivity", () => ({
  watchEvents: {
    addListener: jest.fn(() => jest.fn()),
  },
  sendMessage: jest.fn(),
  updateApplicationContext: jest.fn(),
  getIsPaired: async () => false,
  getReachability: async () => false,
}));

jest.mock("expo-file-system", () => ({
  File: class {},
}));

// The bridge reaches expo-audio through ../src/voice; the real module needs the native side.
jest.mock("expo-audio", () => ({
  useAudioRecorder: () => ({}),
  RecordingPresets: { HIGH_QUALITY: {} },
  AudioModule: { requestRecordingPermissionsAsync: async () => ({ granted: true }) },
}));

function row(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "s1",
    title: "Fix the bug",
    folder: "shop-api",
    status: "idle",
    updatedAt: 1_000,
    ...overrides,
  };
}

describe("buildWatchSnapshot", () => {
  it("orders needs-you first, then working, then idle, newest first within a group", () => {
    const snapshot = buildWatchSnapshot({
      sessions: [
        row({ id: "idle-2", status: "idle", updatedAt: 500 }),
        row({ id: "working", status: "running", updatedAt: 900 }),
        row({ id: "needs-2", status: "error", updatedAt: 100 }),
        row({ id: "idle-1", status: "idle", updatedAt: 800 }),
        row({ id: "needs-1", status: "waiting", updatedAt: 300 }),
      ],
      status: "ready",
      servers: 2,
    });
    expect(snapshot.sessions.map((session) => session.id)).toEqual([
      "needs-1",
      "needs-2",
      "working",
      "idle-1",
      "idle-2",
    ]);
  });

  it("caps the list at 8 rows", () => {
    const snapshot = buildWatchSnapshot({
      sessions: Array.from({ length: 20 }, (_, index) => row({ id: `s${index}` })),
      status: "ready",
      servers: 1,
    });
    expect(snapshot.sessions).toHaveLength(8);
  });

  it("ignores junk rows and malformed input", () => {
    const snapshot = buildWatchSnapshot({
      sessions: [
        null,
        42,
        "nope",
        {},
        row({ id: "" }),
        row({ id: "good", title: 12, folder: null, status: undefined }),
      ],
      status: "ready",
      servers: 1,
    });
    expect(snapshot.sessions).toHaveLength(1);
    expect(snapshot.sessions[0]).toEqual({
      id: "good",
      project: "No workspace",
      title: "No workspace",
      state: "idle",
    });
  });

  it("passes the status through and sanitises the server count", () => {
    expect(buildWatchSnapshot({ sessions: [], status: "reconnecting", servers: 3 })).toEqual({
      ok: true,
      status: "reconnecting",
      servers: 3,
      sessions: [],
      defaultSessionId: null,
    });
    expect(buildWatchSnapshot({ sessions: [], status: "ready", servers: 0 }).servers).toBe(0);
    expect(
      buildWatchSnapshot({ sessions: [], status: "ready", servers: Number.NaN }).servers,
    ).toBe(0);
    expect(
      buildWatchSnapshot({ sessions: [], status: "ready", servers: 2.9 }).servers,
    ).toBe(2);
    expect(
      buildWatchSnapshot({ sessions: null, status: "ready", servers: 1 }).sessions,
    ).toEqual([]);
  });

  it("preselects the first needs-you row, else the most recent", () => {
    const withNeeds = buildWatchSnapshot({
      sessions: [
        row({ id: "idle-1", status: "idle", updatedAt: 800 }),
        row({ id: "needs", status: "waiting", updatedAt: 100 }),
        row({ id: "idle-2", status: "idle", updatedAt: 900 }),
      ],
      status: "ready",
      servers: 1,
    });
    expect(withNeeds.defaultSessionId).toBe("needs");

    const calm = buildWatchSnapshot({
      sessions: [
        row({ id: "idle-1", status: "idle", updatedAt: 800 }),
        row({ id: "idle-2", status: "idle", updatedAt: 900 }),
      ],
      status: "ready",
      servers: 1,
    });
    expect(calm.defaultSessionId).toBe("idle-2");
  });

  it("falls back to the project name for empty titles and maps states", () => {
    const snapshot = buildWatchSnapshot({
      sessions: [
        row({ id: "a", title: "   ", folder: "/Users/demo/projects/web-app" }),
        row({ id: "b", status: "waiting" }),
        row({ id: "c", status: "running" }),
      ],
      status: "ready",
      servers: 1,
    });
    // needs-you first, then working, then idle
    expect(snapshot.sessions.map((r) => r.id)).toEqual(["b", "c", "a"]);
    expect(snapshot.sessions[0]).toMatchObject({ id: "b", state: "needs" });
    expect(snapshot.sessions[1]).toMatchObject({ id: "c", state: "working" });
    expect(snapshot.sessions[2]).toMatchObject({ id: "a", project: "web-app", title: "web-app" });
  });
});

// W4 regression: the demo sequence is connecting -> ready with the rpc
// resolving late and re-renders in between. The fetch and push decisions
// must never drop the snapshot: a fetch always ends in a push, the push is
// throttled from the last ACTUAL push (not from a skipped request), and an
// empty list retries sooner than the throttle window.
describe("fetch/push decisions (W4)", () => {
  const throttle = 2_000;

  it("never fetches while not ready, even when forced", () => {
    expect(
      shouldFetch({ status: "closed", hasRows: false, force: true, lastFetchMs: 0, nowMs: 60_000, throttleMs: throttle }),
    ).toBe(false);
    expect(
      shouldFetch({ status: "connecting", hasRows: false, force: true, lastFetchMs: 0, nowMs: 60_000, throttleMs: throttle }),
    ).toBe(false);
  });

  it("fetches on ready with force, whatever the throttle says", () => {
    expect(
      shouldFetch({ status: "ready", hasRows: true, force: true, lastFetchMs: 60_000, nowMs: 60_500, throttleMs: throttle }),
    ).toBe(true);
  });

  it("retries an empty list sooner than the throttle window", () => {
    expect(
      shouldFetch({ status: "ready", hasRows: false, force: false, lastFetchMs: 59_500, nowMs: 60_000, throttleMs: throttle }),
    ).toBe(true);
    expect(
      shouldFetch({ status: "ready", hasRows: true, force: false, lastFetchMs: 59_500, nowMs: 60_000, throttleMs: throttle }),
    ).toBe(false);
  });

  it("fetches once the throttle window has passed", () => {
    expect(
      shouldFetch({ status: "ready", hasRows: true, force: false, lastFetchMs: 57_000, nowMs: 60_000, throttleMs: throttle }),
    ).toBe(true);
  });

  it("throttles pushes from the last actual push", () => {
    expect(nextPushDelayMs(0, 1_700_000_000_000, throttle)).toBe(0); // nothing pushed yet: the clock is far past 0
    expect(nextPushDelayMs(1_000, 61_000, throttle)).toBe(0); // long past
    expect(nextPushDelayMs(60_000, 60_500, throttle)).toBe(1_500); // just pushed
    expect(nextPushDelayMs(60_000, 62_000, throttle)).toBe(0); // window over
  });

  it("walks the demo sequence: connecting (no fetch) -> ready (fetch) -> rows land -> push", () => {
    let now = 10_000;
    const step = (ms: number) => {
      now += ms;
    };

    // closed/connecting: no fetch, no push of rows
    expect(
      shouldFetch({ status: "connecting", hasRows: false, force: true, lastFetchMs: 0, nowMs: now, throttleMs: throttle }),
    ).toBe(false);

    // ready: forced fetch starts
    step(200);
    expect(
      shouldFetch({ status: "ready", hasRows: false, force: true, lastFetchMs: 0, nowMs: now, throttleMs: throttle }),
    ).toBe(true);

    // the rpc resolves late (after re-renders): rows land, push is due
    step(900);
    const delayAfterRows = nextPushDelayMs(0, now, throttle);
    expect(delayAfterRows).toBe(0);

    // an unrelated re-render asking again within 2 s is throttled (rows exist)
    step(100);
    expect(
      shouldFetch({ status: "ready", hasRows: true, force: false, lastFetchMs: 10_200, nowMs: now, throttleMs: throttle }),
    ).toBe(false);

    // but the status change itself still pushes, after the throttle wait
    expect(nextPushDelayMs(now - 100, now, throttle)).toBe(1_900);
  });
});

// Watch prompts are only forwarded for sessions from the last pushed snapshot;
// a stale watch snapshot must get a short error, not a send into a closed session.
describe("sessionIsPushed", () => {
  const snapshot = buildWatchSnapshot({
    sessions: [row({ id: "s1" }), row({ id: "needs", status: "waiting" })],
    status: "ready",
    servers: 1,
  });

  it("accepts a session that was in the pushed rows", () => {
    expect(sessionIsPushed(snapshot, "s1")).toBe(true);
    expect(sessionIsPushed(snapshot, "needs")).toBe(true);
  });

  it("rejects a session missing from the pushed rows (stale watch snapshot)", () => {
    expect(sessionIsPushed(snapshot, "closed-earlier")).toBe(false);
  });

  it("rejects everything when no rows were pushed", () => {
    const empty = buildWatchSnapshot({ sessions: [], status: "ready", servers: 1 });
    expect(sessionIsPushed(empty, "s1")).toBe(false);
  });
});

// Received clips are forwarded only with a known size inside the 3 MB cap;
// an unknown size counts as over the cap.
describe("forwardableClip", () => {
  const meta = { id: "a1", rid: "a1", sessionId: "s1", format: "m4a" };

  it("forwards a clip with a known size within the cap", () => {
    expect(forwardableClip(meta, 1024)).toMatchObject({ id: "a1", sessionId: "s1" });
  });

  it("rejects a known size over the 3 MB cap", () => {
    expect(forwardableClip(meta, 3 * 1024 * 1024 + 1)).toBeNull();
  });

  it("treats an unknown size as over the cap", () => {
    expect(forwardableClip(meta, undefined)).toBeNull();
  });

  it("rejects non-finite sizes", () => {
    expect(forwardableClip(meta, Number.NaN)).toBeNull();
    expect(forwardableClip(meta, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("still rejects junk metadata even with a good size", () => {
    expect(forwardableClip({ junk: true }, 1024)).toBeNull();
  });
});
