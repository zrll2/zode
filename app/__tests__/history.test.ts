import {
  isSystemLikeUserText,
  mergeHistoryWithLive,
  messagesToItems,
} from "../src/history";

const HISTORY_RESULT = {
  messages: [
    {
      info: { id: "msg_1", role: "user", time: { created: 1 } },
      parts: [{ type: "text", text: "hello" }],
    },
    {
      info: { id: "msg_2", role: "assistant", time: { created: 2, completed: 3 } },
      parts: [
        { type: "reasoning", text: "thinking" },
        { type: "tool", tool: "Write", callID: "call_1", state: { status: "result", output: "ok" } },
        { type: "step-start" },
        { type: "text", text: "done" },
        { type: "step-finish" },
        { type: "timeline" },
      ],
    },
  ],
};

describe("messagesToItems", () => {
  it("converts the verified history shape to chat items", () => {
    const items = messagesToItems(HISTORY_RESULT);
    expect(items.map((i) => i.kind)).toEqual(["user", "reasoning", "tool", "assistant"]);
    expect(items[0]).toMatchObject({ kind: "user", text: "hello" });
    expect(items[1]).toMatchObject({ kind: "reasoning", text: "thinking" });
    expect(items[2]).toMatchObject({
      kind: "tool",
      toolName: "Write",
      toolCallId: "call_1",
      toolState: "result",
      toolOutput: "ok",
    });
    expect(items[3]).toMatchObject({ kind: "assistant", text: "done" });
  });

  it("skips step-start, step-finish and timeline parts", () => {
    expect(messagesToItems(HISTORY_RESULT)).toHaveLength(4);
  });

  it("returns nothing for unparseable results", () => {
    expect(messagesToItems({ nope: true })).toEqual([]);
    expect(messagesToItems(null)).toEqual([]);
    expect(messagesToItems({ messages: "not an array" })).toEqual([]);
  });
});

describe("mergeHistoryWithLive", () => {
  it("shows live items after history", () => {
    const history = messagesToItems(HISTORY_RESULT);
    const live = [{ key: "u1", kind: "user" as const, text: "next question" }];
    expect(mergeHistoryWithLive(history, live)).toEqual([...history, ...live]);
  });

  it("drops the history turn that a live replay duplicates", () => {
    const history = messagesToItems(HISTORY_RESULT);
    const live = [
      { key: "u1", kind: "user" as const, text: "hello" },
      { key: "a1", kind: "assistant" as const, text: "done (replayed)" },
    ];
    expect(mergeHistoryWithLive(history, live)).toEqual(live);
  });

  it("keeps history when live starts mid-turn without user input", () => {
    const history = messagesToItems(HISTORY_RESULT);
    const live = [{ key: "a1", kind: "assistant" as const, text: "streaming…" }];
    expect(mergeHistoryWithLive(history, live)).toEqual([...history, ...live]);
  });
});

describe("tool parts", () => {
  it("carries input and output for the tool row", () => {
    const result = {
      messages: [
        {
          info: { id: "m1", role: "assistant" },
          parts: [
            {
              type: "tool",
              tool: "Read",
              callID: "c1",
              state: { status: "result", input: "/tmp/a.txt", output: "line one" },
            },
          ],
        },
      ],
    };
    expect(messagesToItems(result)[0]).toMatchObject({
      kind: "tool",
      toolName: "Read",
      toolInput: "/tmp/a.txt",
      toolOutput: "line one",
    });
  });
});

describe("isSystemLikeUserText", () => {
  it("detects harness-injected user messages", () => {
    expect(isSystemLikeUserText("<task-notification>done</task-notification>")).toBe(true);
    expect(isSystemLikeUserText("<system-reminder>stay sharp</system-reminder>")).toBe(true);
    expect(isSystemLikeUserText("<command-name>/review</command-name>")).toBe(true);
    expect(isSystemLikeUserText("Available agent types for the Agent tool: general-purpose")).toBe(true);
    expect(isSystemLikeUserText("The TodoWrite tool hasn't been used recently. Consider using it.")).toBe(true);
    expect(isSystemLikeUserText("\n  <system-reminder>indented</system-reminder>")).toBe(true);
  });

  it("treats normal user text as a bubble", () => {
    expect(isSystemLikeUserText("Please fix the redirect bug")).toBe(false);
    expect(isSystemLikeUserText("")).toBe(false);
    expect(isSystemLikeUserText("available agent types")).toBe(false);
  });
});

describe("hidden-marked messages", () => {
  const fixture = {
    messages: [
      {
        info: {
          id: "m1",
          role: "user",
          semantics: { uiVisibility: "hidden", kind: "todo_reminder" },
        },
        parts: [{ type: "text", text: "The TodoWrite tool hasn't been used recently…" }],
      },
      {
        info: { id: "m2", role: "user" },
        parts: [{ type: "text", text: "Please fix the redirect bug" }],
      },
      {
        info: { id: "m3", role: "assistant" },
        parts: [{ type: "text", text: "On it." }],
      },
    ],
  };

  it("drops hidden-marked messages completely", () => {
    const items = messagesToItems(fixture);
    expect(items.map((item) => item.key)).toEqual(["h-m2-0", "h-m3-0"]);
  });

  it("keeps visible user and assistant messages", () => {
    const items = messagesToItems(fixture);
    expect(items[0]).toMatchObject({ kind: "user", text: "Please fix the redirect bug" });
    expect(items[1]).toMatchObject({ kind: "assistant", text: "On it." });
  });

  it("still becomes a system row when an unmarked user message matches a prefix", () => {
    const unmarked = {
      messages: [
        {
          info: { id: "u1", role: "user" },
          parts: [{ type: "text", text: "<task-notification>background task done</task-notification>" }],
        },
        {
          info: { id: "u2", role: "user" },
          parts: [
            {
              type: "text",
              text: "The TodoWrite tool hasn't been used recently. Consider using it actively.",
            },
          ],
        },
      ],
    };
    const items = messagesToItems(unmarked);
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item.kind).toBe("user");
      expect(isSystemLikeUserText(item.text)).toBe(true);
    }
  });
});
