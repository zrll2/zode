import { buildWatchSnapshot } from "../src/watchBridge";

// Nothing native may load: the bridge imports react-native-watch-connectivity
// lazily, but mock it anyway so an accidental eager import stays harmless.
jest.mock("react-native-watch-connectivity", () => ({
  watchEvents: {
    addListener: jest.fn(() => jest.fn()),
  },
  sendMessage: jest.fn(),
  updateApplicationContext: jest.fn(),
  getIsPaired: async () => false,
  getReachability: async () => false,
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
