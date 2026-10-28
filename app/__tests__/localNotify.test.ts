import { localNotifyFor, remotePushActive } from "../src/localNotify";
import { initialSessionState } from "../src/relay/reducer";

jest.mock("expo-secure-store", () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => undefined),
  deleteItemAsync: jest.fn(async () => undefined),
}));

const bg = { appState: "background" };
const running = { ...initialSessionState("s1"), running: true };
const finished = (over: Partial<ReturnType<typeof initialSessionState>> = {}) => ({
  ...initialSessionState("s1"),
  title: "web-app",
  lastResponse: "web-app done",
  ...over,
});

describe("localNotifyFor", () => {
  it("stays quiet while the app is in the foreground", () => {
    expect(localNotifyFor(running, finished(), { appState: "active" })).toBeNull();
  });

  it("announces a finished turn in the background, without sound", () => {
    expect(localNotifyFor(running, finished(), bg)).toEqual({
      title: "web-app",
      body: "web-app done",
      sound: false,
    });
  });

  it("falls back to a generic body when there is no response text", () => {
    expect(localNotifyFor(running, finished({ lastResponse: null }), bg)?.body).toBe("Task finished");
    expect(localNotifyFor(running, finished({ lastResponse: "  \n " }), bg)?.body).toBe("Task finished");
  });

  it("caps the body at 120 characters", () => {
    const long = finished({ lastResponse: "x".repeat(500) });
    expect(localNotifyFor(running, long, bg)?.body).toHaveLength(120);
  });

  it("announces a fresh approval request with sound", () => {
    const asking = finished({
      permissionRequest: { toolName: "Bash", message: "Run npm test" },
    });
    expect(localNotifyFor(finished(), asking, bg)).toEqual({
      title: "web-app",
      body: "Wants to use Bash",
      sound: true,
    });
  });

  it("does not re-announce an already-visible request", () => {
    const asking = finished({
      permissionRequest: { toolName: "Bash", message: "Run npm test" },
    });
    expect(localNotifyFor(asking, asking, bg)).toBeNull();
  });

  it("ignores non-transitions", () => {
    expect(localNotifyFor(running, running, bg)).toBeNull();
    expect(localNotifyFor(finished(), finished(), bg)).toBeNull();
  });
});

describe("remotePushActive", () => {
  const input = (over: {
    pushEnabled?: boolean;
    pushId?: string | null;
    relayPush?: boolean;
  }) => ({
    pushEnabled: over.pushEnabled ?? true,
    // `in` on purpose: an explicit undefined must stay undefined so the
    // "pushId: undefined" case is actually exercised.
    pushId: "pushId" in over ? (over.pushId as string | null) : "push-1",
    relayPush: over.relayPush ?? true,
  });

  it("is true only when all three signals say push works", () => {
    expect(remotePushActive(input({}))).toBe(true);
  });

  it("is false when any single signal is missing", () => {
    expect(remotePushActive(input({ pushEnabled: false }))).toBe(false);
    expect(remotePushActive(input({ pushId: null }))).toBe(false);
    expect(remotePushActive(input({ pushId: undefined }))).toBe(false);
    expect(remotePushActive(input({ pushId: "" }))).toBe(false);
    expect(remotePushActive(input({ relayPush: false }))).toBe(false);
  });

  it("is false when nothing is set (fresh install)", () => {
    expect(
      remotePushActive({ pushEnabled: false, pushId: null, relayPush: false }),
    ).toBe(false);
  });
});
