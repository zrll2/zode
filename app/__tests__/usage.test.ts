import {
  dailyBars,
  formatPercent,
  formatTokens,
  parseAccountUsage,
  parseSessionUsage,
} from "../src/usage";

describe("formatTokens", () => {
  it("formats small numbers as-is", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(950)).toBe("950");
  });

  it("formats thousands with one decimal", () => {
    expect(formatTokens(12_345)).toBe("12.3K");
    expect(formatTokens(1_000)).toBe("1K");
  });

  it("formats millions with one decimal", () => {
    expect(formatTokens(4_500_000)).toBe("4.5M");
    expect(formatTokens(2_000_000)).toBe("2M");
  });

  it("formats billions with two decimals", () => {
    expect(formatTokens(5_662_760_401)).toBe("5.66B");
  });
});

describe("formatPercent", () => {
  it("turns a 0..1 fraction into one-decimal percent", () => {
    expect(formatPercent(0.986)).toBe("98.6%");
    expect(formatPercent(1)).toBe("100.0%");
    expect(formatPercent(0)).toBe("0.0%");
  });
});

describe("parseSessionUsage", () => {
  it("parses the verified shape", () => {
    expect(
      parseSessionUsage({
        sessionId: "sess_1",
        totalTokens: 465_541,
        inputTokens: 465_176,
        outputTokens: 365,
        reasoningTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 322_368,
        modelRequestCount: 3,
        modelErrorCount: 0,
      }),
    ).toEqual({
      sessionId: "sess_1",
      totalTokens: 465_541,
      inputTokens: 465_176,
      outputTokens: 365,
      reasoningTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 322_368,
      modelRequestCount: 3,
      modelErrorCount: 0,
    });
  });

  it("falls back to zeros for missing fields", () => {
    expect(parseSessionUsage(null)).toEqual({
      sessionId: null,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      modelRequestCount: 0,
      modelErrorCount: 0,
    });
    expect(parseSessionUsage({ totalTokens: "lots" }).totalTokens).toBe(0);
  });
});

const STATS = {
  range: "30d",
  generatedAt: "2026-10-20T09:00:00Z",
  summary: {
    totalTokens: 5_662_760_401,
    inputTokens: 4_900_000_000,
    outputTokens: 640_000_000,
    cacheReadTokens: 3_100_000_000,
    cacheHitRate: 0.62,
    totalSessions: 148,
    totalTurns: 1_204,
    toolCallCount: 6_512,
    toolErrorRate: 0.02,
    activeDays: 41,
    favoriteModel: { modelId: "GLM-5.3-Flash", totalTokens: 4_100_000_000, share: 0.72 },
  },
  heatmap: {
    weeks: [
      {
        days: [
          { date: "2026-10-05", totalTokens: 100, turnCount: 1 },
          { date: "2026-10-06", totalTokens: 300, turnCount: 2 },
          null,
        ],
      },
      {
        days: [{ date: "2026-10-12", totalTokens: 200, turnCount: 1 }],
      },
    ],
  },
  dailyModelUsage: [],
};

describe("parseAccountUsage", () => {
  it("parses the real shape and flattens the heatmap, skipping null days", () => {
    const usage = parseAccountUsage(STATS);
    expect(usage.range).toBe("30d");
    expect(usage.summary.totalTokens).toBe(5_662_760_401);
    expect(usage.summary.cacheHitRate).toBe(0.62);
    expect(usage.summary.totalSessions).toBe(148);
    expect(usage.summary.favoriteModel).toBe("GLM-5.3-Flash");
    expect(usage.summary.favoriteModelShare).toBe(0.72);
    expect(usage.days).toEqual([
      { date: "2026-10-05", tokens: 100, turns: 1 },
      { date: "2026-10-06", tokens: 300, turns: 2 },
      { date: "2026-10-12", tokens: 200, turns: 1 },
    ]);
  });

  it("falls back to safe defaults", () => {
    const usage = parseAccountUsage(null);
    expect(usage.range).toBeNull();
    expect(usage.summary.totalTokens).toBe(0);
    expect(usage.summary.cacheHitRate).toBeNull();
    expect(usage.summary.favoriteModel).toBeNull();
    expect(usage.days).toEqual([]);
  });
});

describe("dailyBars", () => {
  it("takes the last days, skips nulls and levels relative to the max", () => {
    const bars = dailyBars(STATS, 5);
    expect(bars).toHaveLength(3);
    expect(bars[0]).toEqual({ date: "2026-10-05", tokens: 100, level: 100 / 300 });
    expect(bars[1]).toEqual({ date: "2026-10-06", tokens: 300, level: 1 });
    expect(bars[2]?.level).toBeCloseTo(200 / 300);
  });

  it("returns fewer bars when the heatmap has fewer days than asked", () => {
    expect(dailyBars(STATS, 30)).toHaveLength(3);
    expect(dailyBars({ heatmap: { weeks: [] } }, 14)).toEqual([]);
  });
});
