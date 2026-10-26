import { gcm } from "@noble/ciphers/aes.js";
import { utf8ToBytes } from "@noble/ciphers/utils.js";
import { bytesToBase64Url } from "../src/push";
import { PUSH_ACTION_TASK, runPushAction, type PushRelay } from "../src/pushActions";

jest.mock("expo-notifications", () => ({
  setNotificationHandler: jest.fn(),
  addNotificationResponseReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
  registerTaskAsync: jest.fn(async () => null),
  scheduleNotificationAsync: jest.fn(async () => "local"),
}));

jest.mock("expo-task-manager", () => ({
  defineTask: jest.fn(),
}));

jest.mock("expo-secure-store", () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => undefined),
  deleteItemAsync: jest.fn(async () => undefined),
}));

// The fake relay client: records what the action sent and lets the test
// decide whether connect() or respond() fails/times out.
function fakeClient(options: { connectError?: Error; respondError?: Error } = {}) {
  const sent: Array<Record<string, unknown>> = [];
  return {
    client: {
      connect: jest.fn(async () => {
        if (options.connectError) throw options.connectError;
      }),
      respond: jest.fn(async (server: string, id: string, decision: string) => {
        if (options.respondError) throw options.respondError;
        sent.push({ type: "respond", server, id, decision });
        return { ok: true };
      }),
      rpc: jest.fn(async (method: string, params?: unknown) => {
        sent.push({ type: method, ...(params as object) });
        return {};
      }),
      close: jest.fn(),
    } as unknown as PushRelay & Record<string, jest.Mock>,   // a fake: only the slice the actions use
    sent,
  };
}

const KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const IV = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);

function sealedData(kind: string, payload: Record<string, unknown>) {
  const sealed = gcm(fromKey(), IV, utf8ToBytes(kind)).encrypt(utf8ToBytes(JSON.stringify(payload)));
  return { k: kind, s: bytesToBase64Url(sealed) };
}

function fromKey() {
  // same 32 bytes as KEY
  return Uint8Array.from({ length: 32 }, (_, i) => i);
}

const CREDS = {
  wsUrl: "ws://192.168.1.5:8787",
  wsUrls: ["ws://192.168.1.5:8787"],
  token: "tok",
  deviceId: "dev",
  pushKey: KEY,
};

function notificationData(data: Record<string, unknown>, identifier = "notif-1") {
  return {
    actionIdentifier: "allow",
    userText: undefined,
    notification: {
      request: { identifier, content: { data } },
    },
  };
}

function deps(overrides: Record<string, unknown> = {}) {
  const { client, sent } = fakeClient(overrides.clientOptions ?? {});
  const scheduled: Array<{ title: string; body: string }> = [];
  const opened: Array<string | null> = [];
  const notifications = {
    scheduleNotificationAsync: jest.fn(async (input: { content: { title: string; body: string } }) => {
      scheduled.push(input.content);
      return "local-1";
    }),
  };
  const base = {
    connect: jest.fn(() => client),
    loadCredentials: jest.fn(async () => CREDS),
    notifications,
    openConversation: jest.fn((id: string | null) => {
      opened.push(id);
    }),
    ...overrides,
  };
  return { base, client, sent, scheduled, opened };
}

describe("runPushAction: allow/deny", () => {
  it("sends a respond frame for allow and closes the connection", async () => {
    const { base, sent, client } = deps();
    const data = sealedData("ask", {
      v: 1,
      kind: "ask",
      title: "web-app",
      body: "Run: npm test",
      session: "sess_1",
      at: 1,
      req: { server: "101", id: "req-9" },
    });
    await runPushAction(notificationData(data, "n1"), base);
    expect(sent).toEqual([{ type: "respond", server: "101", id: "req-9", decision: "allow" }]);
    expect(client.connect).toHaveBeenCalled();
    expect(client.close).toHaveBeenCalled();
  });

  it("sends deny", async () => {
    const { base, sent } = deps();
    const data = sealedData("ask", {
      v: 1,
      kind: "ask",
      title: "t",
      body: "b",
      at: 1,
      req: { server: "7", id: "req-2" },
    });
    await runPushAction({ ...notificationData(data, "n2"), actionIdentifier: "deny" }, base);
    expect(sent).toEqual([{ type: "respond", server: "7", id: "req-2", decision: "deny" }]);
  });

  it("shows the local failure notification when the relay cannot be reached", async () => {
    const { base, scheduled, sent } = deps({
      clientOptions: { connectError: new Error("nope") },
    });
    const data = sealedData("ask", {
      v: 1,
      kind: "ask",
      title: "t",
      body: "b",
      at: 1,
      req: { server: "7", id: "req-2" },
    });
    await runPushAction(notificationData(data, "n3"), base);
    expect(sent).toEqual([]);
    expect(scheduled).toEqual([{ title: "Zode", body: "Could not reach your Mac" }]);
  });

  it("keeps one action in flight per notification id", async () => {
    const { base, sent } = deps();
    const data = sealedData("ask", {
      v: 1,
      kind: "ask",
      title: "t",
      body: "b",
      at: 1,
      req: { server: "7", id: "req-2" },
    });
    const first = runPushAction(notificationData(data, "same"), base);
    const second = runPushAction(notificationData(data, "same"), base);
    await Promise.all([first, second]);
    expect(sent).toHaveLength(1);
  });
});

describe("runPushAction: reply", () => {
  it("sends the typed text as a session/send prompt", async () => {
    const { base, sent } = deps();
    const data = sealedData("question", {
      v: 1,
      kind: "question",
      title: "t",
      body: "Continue?",
      session: "sess_7",
      at: 1,
    });
    await runPushAction(
      { ...notificationData(data, "n4"), actionIdentifier: "reply", userText: "  yes please  " },
      base,
    );
    expect(sent).toEqual([
      {
        type: "session/send",
        sessionId: "sess_7",
        content: "yes please",
        modelSelection: {
          providerId: "account:zai-individual-coding-plan",
          modelId: "GLM-5.3-Flash",
          options: { reasoningLevel: "max" },
        },
      },
    ]);
  });

  it("ignores an empty reply", async () => {
    const { base, sent } = deps();
    const data = sealedData("question", {
      v: 1,
      kind: "question",
      title: "t",
      body: "Continue?",
      session: "sess_7",
      at: 1,
    });
    await runPushAction(
      { ...notificationData(data, "n5"), actionIdentifier: "reply", userText: "   " },
      base,
    );
    expect(sent).toEqual([]);
  });
});

describe("runPushAction: guards", () => {
  it("opens the conversation for the default action", async () => {
    const { base, opened, sent } = deps();
    const data = sealedData("done", {
      v: 1,
      kind: "done",
      title: "t",
      body: "b",
      session: "sess_3",
      at: 1,
    });
    await runPushAction(
      { ...notificationData(data, "n6"), actionIdentifier: "expo.modules.notifications.actions.DEFAULT" },
      base,
    );
    expect(opened).toEqual(["sess_3"]);
    expect(sent).toEqual([]);
  });

  it("returns quietly without a push key or junk data", async () => {
    const { base: noKey, sent } = deps({
      loadCredentials: async () => ({ ...CREDS, pushKey: undefined }),
    });
    const data = sealedData("ask", {
      v: 1,
      kind: "ask",
      title: "t",
      body: "b",
      at: 1,
      req: { server: "7", id: "r" },
    });
    await runPushAction(notificationData(data, "n7"), noKey);
    expect(sent).toEqual([]);

    const { base: junk } = deps();
    await runPushAction(notificationData({ junk: true }, "n8"), junk);
    await runPushAction(null as unknown as Parameters<typeof runPushAction>[0], junk);
  });

  it("ignores asks without a req block", async () => {
    const { base, sent } = deps();
    const data = sealedData("ask", { v: 1, kind: "ask", title: "t", body: "b", at: 1 });
    await runPushAction(notificationData(data, "n9"), base);
    expect(sent).toEqual([]);
  });
});

describe("task name", () => {
  it("is stable", () => {
    expect(PUSH_ACTION_TASK).toBe("zode.push.action");
  });
});
