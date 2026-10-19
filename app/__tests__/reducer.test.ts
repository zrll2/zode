import fs from "fs";
import path from "path";
import { initialSessionState, reduce, type SessionState } from "../src/relay/reducer";
import type { RelayMessage } from "../src/relay/protocol";

const SESSION = "sess_demo0000-0000-0000-0000-000000000001";

function loadFixture(): RelayMessage[] {
  const file = path.join(__dirname, "..", "fixtures", "events-sample.jsonl");
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function reduceAll(messages: RelayMessage[], sessionId = SESSION): SessionState {
  let state = initialSessionState(sessionId);
  for (const msg of messages) state = reduce(state, msg);
  return state;
}

it("reduces the recorded turn from the fixture", () => {
  const state = reduceAll(loadFixture());

  expect(state.title).toContain("In the current directory");
  expect(state.running).toBe(false);
  expect(state.lastResponse).toBe("verified.");

  const kinds = state.items.map((i) => i.kind);
  expect(kinds).toContain("user");
  expect(kinds).toContain("reasoning");
  expect(kinds).toContain("tool");
  expect(kinds).toContain("assistant");

  const user = state.items.find((i) => i.kind === "user");
  expect(user?.text).toContain("create a.txt");

  const reasoning = state.items.find((i) => i.kind === "reasoning");
  expect(reasoning?.text).toContain("user wants me to");

  const write = state.items.find((i) => i.kind === "tool" && i.toolName === "Write");
  expect(write?.toolCallId).toBe("call_96fd1eb1e87446d092b92c74");
  // the sample stops after `started`; later `result` events would update it
  expect(write?.toolState).toBe("started");

  const assistants = state.items.filter((i) => i.kind === "assistant");
  expect(assistants).toHaveLength(1);
  expect(assistants[0].text).toBe("verified.");
});

it("ignores events of other sessions", () => {
  const state = initialSessionState(SESSION);
  const other = reduce(state, {
    method: "session/event",
    params: { type: "turn.started", sessionId: "sess_other", payload: { input: "hi" } },
  });
  expect(other).toBe(state);
});

it("turn.started sets running and shows the user input", () => {
  let state = initialSessionState(SESSION);
  state = reduce(state, {
    method: "session/event",
    params: { type: "turn.started", sessionId: SESSION, payload: { input: "hello world" } },
  });
  expect(state.running).toBe(true);
  expect(state.items[0]).toMatchObject({ kind: "user", text: "hello world" });
});

it("streams deltas into one item and finalizes on turn.completed", () => {
  let state = initialSessionState(SESSION);
  const stream = (delta: string, kind = "text_delta") =>
    reduce(state, {
      method: "session/event",
      params: { type: "model.streaming", sessionId: SESSION, payload: { kind, delta, done: false } },
    });
  state = stream("Hel");
  state = stream("lo");
  expect(state.items.filter((i) => i.kind === "assistant")).toHaveLength(1);
  const item = state.items.find((i) => i.kind === "assistant");
  expect(item?.text).toBe("Hello");
  expect(item?.streaming).toBe(true);

  state = reduce(state, {
    method: "session/event",
    params: { type: "turn.completed", sessionId: SESSION, payload: { response: "Hello!", resultType: "success" } },
  });
  expect(state.running).toBe(false);
  expect(state.lastResponse).toBe("Hello!");
  const done = state.items.find((i) => i.kind === "assistant");
  expect(done?.text).toBe("Hello!");
  expect(done?.streaming).toBe(false);
});

it("updates a tool card by toolCallId", () => {
  let state = initialSessionState(SESSION);
  const tool = (kind: string) =>
    reduce(state, {
      method: "session/event",
      params: {
        type: "tool.updated",
        sessionId: SESSION,
        payload: { toolCallId: "call_1", toolName: "Read", kind },
      },
    });
  state = tool("scheduled");
  state = tool("started");
  state = tool("result");
  const cards = state.items.filter((i) => i.kind === "tool");
  expect(cards).toHaveLength(1);
  expect(cards[0]).toMatchObject({ toolName: "Read", toolState: "result" });
});

it("tracks state.updated status patches", () => {
  let state = initialSessionState(SESSION);
  state = reduce(state, {
    method: "state.updated",
    params: { sessionId: SESSION, patch: { status: "running" } },
  });
  expect(state.running).toBe(true);
  state = reduce(state, {
    method: "state.updated",
    params: { sessionId: SESSION, patch: { status: "idle" } },
  });
  expect(state.running).toBe(false);
});

it("shows an error item when a failed turn carries an error", () => {
  let state = initialSessionState(SESSION);
  state = reduce(state, {
    method: "session/event",
    params: {
      type: "turn.completed",
      sessionId: SESSION,
      payload: { resultType: "error", error: { message: "Reasoning level is required" } },
    },
  });
  const error = state.items.find((i) => i.kind === "error");
  expect(error?.text).toBe("Reasoning level is required");
  expect(state.running).toBe(false);
});

it("records a permission request as a read-only banner", () => {
  let state = initialSessionState(SESSION);
  state = reduce(state, {
    method: "session/event",
    params: {
      type: "permission.requested",
      sessionId: SESSION,
      payload: { toolName: "Bash", message: "Allow rm -rf /tmp/x?" },
    },
  });
  expect(state.permissionRequest).toEqual({
    toolName: "Bash",
    message: "Allow rm -rf /tmp/x?",
  });
});
