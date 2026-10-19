import { DemoClient } from "../src/demo/DemoClient";
import { initialSessionState, reduce, type SessionState } from "../src/relay/reducer";
import { messagesToItems } from "../src/history";

async function readyClient() {
  const client = new DemoClient();
  await client.connect();
  return client;
}

it("session/list returns fictional sessions with real status values and demo paths", async () => {
  const client = await readyClient();
  const result: any = await client.rpc("session/list", {});
  const titles = result.sessions.map((session: any) => session.title);
  expect(titles).toContain("Fix login redirect loop");
  expect(titles).toContain("Port settings page to the new design");
  expect(titles).toContain("Add dark mode toggle");
  for (const session of result.sessions) {
    expect(["idle", "running", "waiting", "error"]).toContain(session.status);
    expect(session.workspace.workspacePath).toMatch(/^\/Users\/demo\/projects\/[a-z-]+$/);
    expect(session.workspace.workspaceKey).toBe(
      session.workspace.workspacePath.split("/").pop(),
    );
  }
});

it("session/messages converts into user, assistant, tool and reasoning items", async () => {
  const client = await readyClient();
  const result: any = await client.rpc("session/messages", {
    sessionId: "demo-dark-mode",
  });
  const kinds = new Set(messagesToItems(result).map((item) => item.kind));
  expect(kinds.has("user")).toBe(true);
  expect(kinds.has("assistant")).toBe(true);
  expect(kinds.has("tool")).toBe(true);
  expect(kinds.has("reasoning")).toBe(true);
});

it("sending a message emits events the reducer turns into a finished assistant item", async () => {
  jest.useFakeTimers();
  try {
    const client = await readyClient();
    const messages: any[] = [];
    client.onEvent((msg) => messages.push(msg));
    await client.rpc("session/send", {
      sessionId: "demo-dark-mode",
      content: "hello demo",
    });
    jest.runAllTimers();

    const state: SessionState = messages.reduce(
      (current, msg) => reduce(current, msg),
      initialSessionState("demo-dark-mode"),
    );
    expect(state.running).toBe(false);
    const assistants = state.items.filter((item) => item.kind === "assistant");
    expect(assistants.length).toBeGreaterThan(0);
    expect(assistants[assistants.length - 1]?.text).toContain(
      "This is a demo reply. In real use, ZCode would do the work on your Mac.",
    );
    const tools = state.items.filter((item) => item.kind === "tool");
    expect(tools).toHaveLength(1);
    expect(tools[0]?.toolName).toBe("Read");
  } finally {
    jest.useRealTimers();
  }
});

it("stop ends a running turn", async () => {
  jest.useFakeTimers();
  try {
    const client = await readyClient();
    const messages: any[] = [];
    client.onEvent((msg) => messages.push(msg));
    await client.rpc("session/send", { sessionId: "demo-dark-mode", content: "go" });
    jest.advanceTimersByTime(200); // mid-turn
    await client.rpc("session/stop", { sessionId: "demo-dark-mode" });
    jest.runAllTimers();

    const state: SessionState = messages.reduce(
      (current, msg) => reduce(current, msg),
      initialSessionState("demo-dark-mode"),
    );
    expect(state.running).toBe(false);
    const completions = messages.filter((msg: any) => msg.params?.type === "turn.completed");
    expect(completions).toHaveLength(1);
    expect(completions[0]?.params?.payload?.resultType).toBe("stopped");
  } finally {
    jest.useRealTimers();
  }
});

it("keeps every sample path under /Users/demo", async () => {
  const client = await readyClient();
  const list: any = await client.rpc("session/list", {});
  const darkMode: any = await client.rpc("session/messages", { sessionId: "demo-dark-mode" });
  const login: any = await client.rpc("session/messages", {
    sessionId: "demo-login-redirect",
  });
  const matches = JSON.stringify([list, darkMode, login]).match(/\/Users\/[^"]*/g) ?? [];
  expect(matches.length).toBeGreaterThan(0);
  for (const path of matches) {
    expect(path.startsWith("/Users/demo")).toBe(true);
  }
});
