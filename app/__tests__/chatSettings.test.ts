import {
  buildRenameParams,
  buildSetModelParams,
  buildSetThoughtLevelParams,
  emptyChatSettings,
  parseChatSettings,
  type ModelOption,
} from "../src/chatSettings";

const RESUME = {
  settings: {
    model: {
      current: {
        providerId: "account:zai-individual-coding-plan",
        modelId: "GLM-5.3-Flash",
        options: { reasoningLevel: "max" },
      },
      available: [
        {
          ref: {
            providerId: "account:zai-individual-coding-plan",
            modelId: "GLM-5.3-Flash",
          },
          label: "GLM-5.3",
          providerLabel: "Z.AI Individual Coding Plan",
          contextWindow: 1_000_000,
          maxOutputTokens: 128_000,
          reasoning: {
            levels: [
              { value: "low", label: "low" },
              { value: "high", label: "high" },
              { value: "max", label: "max" },
            ],
            defaultLevel: "max",
          },
        },
        {
          ref: {
            providerId: "account:zai-individual-coding-plan",
            modelId: "GLM-5.3-Turbo",
          },
          label: "GLM-5.3 Turbo",
          providerLabel: "Z.AI Individual Coding Plan",
          reasoning: {
            levels: [
              { value: "low", label: "low" },
              { value: "high", label: "high" },
            ],
            defaultLevel: "high",
          },
        },
      ],
    },
    thoughtLevel: {
      available: [
        { label: "low", value: "low" },
        { label: "high", value: "high" },
        { label: "max", value: "max" },
      ],
      current: "max",
      enabled: true,
    },
  },
  projection: {
    contextUsed: 84_000,
    contextWindow: 1_000_000,
    totalTokenCount: 465_541,
    turnCount: 6,
    status: "idle",
  },
};

describe("parseChatSettings", () => {
  it("parses a real-shaped resume result", () => {
    const settings = parseChatSettings(RESUME);
    expect(settings.model).toEqual({
      providerId: "account:zai-individual-coding-plan",
      modelId: "GLM-5.3-Flash",
      label: "GLM-5.3-Flash",
      reasoningLevel: "max",
    });
    expect(settings.models).toHaveLength(2);
    expect(settings.models[0]).toMatchObject({
      providerId: "account:zai-individual-coding-plan",
      modelId: "GLM-5.3-Flash",
      label: "GLM-5.3",
      providerLabel: "Z.AI Individual Coding Plan",
      reasoningLevels: ["low", "high", "max"],
      defaultLevel: "max",
    });
    expect(settings.models[1]?.reasoningLevels).toEqual(["low", "high"]);
    expect(settings.models[1]?.defaultLevel).toBe("high");
    expect(settings.thoughtLevels).toEqual(["low", "high", "max"]);
    expect(settings.thoughtLevel).toBe("max");
    expect(settings.contextUsed).toBe(84_000);
    expect(settings.contextWindow).toBe(1_000_000);
  });

  it("parses a minimal result", () => {
    const settings = parseChatSettings({
      settings: { model: { current: { providerId: "p", modelId: "m" } } },
    });
    expect(settings.model).toEqual({
      providerId: "p",
      modelId: "m",
      label: "m",
      reasoningLevel: null,
    });
    expect(settings.models).toEqual([]);
    expect(settings.thoughtLevels).toEqual([]);
    expect(settings.thoughtLevel).toBeNull();
    expect(settings.contextUsed).toBeNull();
    expect(settings.contextWindow).toBeNull();
  });

  it("gives empty defaults for garbage input", () => {
    const empty = emptyChatSettings();
    expect(parseChatSettings(null)).toEqual(empty);
    expect(parseChatSettings(undefined)).toEqual(empty);
    expect(parseChatSettings("nope")).toEqual(empty);
    expect(parseChatSettings({ settings: 7 })).toEqual(empty);
    expect(parseChatSettings({ settings: { model: { available: "nope" } } })).toEqual(empty);
  });
});

describe("builders", () => {
  const option: ModelOption = {
    providerId: "p",
    modelId: "m2",
    label: "M2",
    providerLabel: "P",
    reasoningLevels: ["low", "high"],
    defaultLevel: "high",
  };

  it("builds setModel params with and without a level", () => {
    expect(buildSetModelParams("s", option, "low")).toEqual({
      sessionId: "s",
      model: { providerId: "p", modelId: "m2", options: { reasoningLevel: "low" } },
    });
    expect(buildSetModelParams("s", option)).toEqual({
      sessionId: "s",
      model: { providerId: "p", modelId: "m2" },
    });
  });

  it("builds thought level params", () => {
    expect(buildSetThoughtLevelParams("s", "high")).toEqual({
      sessionId: "s",
      thoughtLevel: "high",
    });
  });

  it("trims and caps rename titles at 120 characters", () => {
    expect(buildRenameParams("s", "  New name  ")).toEqual({
      sessionId: "s",
      title: "New name",
    });
    const long = buildRenameParams("s", `  ${"x".repeat(200)}  `);
    expect(long.title).toHaveLength(120);
  });
});
