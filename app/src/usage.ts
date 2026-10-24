// Parsing and formatting for usage stats (order 17c). Numbers can be huge;
// formatTokens shrinks them to K / M / B.

export type UsageTone = "normal" | "warn" | "danger";

// Context-fullness chip for the composer: null when the window is missing,
// zero or negative; otherwise the rounded percent (clamped to 0..100) with a
// tone — warn from 70 %, danger from 90 %.
export function usageChip(
  contextUsed: unknown,
  contextWindow: unknown,
): { label: string; tone: UsageTone; percent: number } | null {
  if (
    typeof contextWindow !== "number" ||
    !Number.isFinite(contextWindow) ||
    contextWindow <= 0
  ) {
    return null;
  }
  const used = typeof contextUsed === "number" && Number.isFinite(contextUsed) ? contextUsed : 0;
  const percent = Math.min(100, Math.max(0, Math.round((used / contextWindow) * 100)));
  const tone: UsageTone = percent >= 90 ? "danger" : percent >= 70 ? "warn" : "normal";
  return { label: `${percent}%`, tone, percent };
}

function scaled(value: number, unit: string, digits: number): string {
  let out = value.toFixed(digits);
  if (out.includes(".")) out = out.replace(/0+$/, "").replace(/\.$/, "");
  return `${out}${unit}`;
}

export function formatTokens(count: number): string {
  if (!Number.isFinite(count)) return "0";
  const magnitude = Math.abs(count);
  if (magnitude >= 1e9) return scaled(count / 1e9, "B", 2);
  if (magnitude >= 1e6) return scaled(count / 1e6, "M", 1);
  if (magnitude >= 1e3) return scaled(count / 1e3, "K", 1);
  return String(Math.round(count));
}

export function formatPercent(fraction: number): string {
  if (!Number.isFinite(fraction)) return "0.0%";
  return `${(fraction * 100).toFixed(1)}%`;
}

export interface SessionUsage {
  sessionId: string | null;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  modelRequestCount: number;
  modelErrorCount: number;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function parseSessionUsage(result: unknown): SessionUsage {
  const data = (result ?? {}) as Record<string, any>;
  return {
    sessionId: typeof data.sessionId === "string" ? data.sessionId : null,
    totalTokens: num(data.totalTokens),
    inputTokens: num(data.inputTokens),
    outputTokens: num(data.outputTokens),
    reasoningTokens: num(data.reasoningTokens),
    cacheCreationTokens: num(data.cacheCreationTokens),
    cacheReadTokens: num(data.cacheReadTokens),
    modelRequestCount: num(data.modelRequestCount),
    modelErrorCount: num(data.modelErrorCount),
  };
}

export interface AccountUsageSummary {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheHitRate: number | null;
  totalSessions: number | null;
  totalTurns: number | null;
  toolCallCount: number | null;
  favoriteModel: string | null;
  favoriteModelShare: number | null;
}

export interface AccountUsageDay {
  date: string;
  tokens: number;
  turns: number;
}

export interface AccountUsage {
  range: string | null;
  summary: AccountUsageSummary;
  days: AccountUsageDay[];
}

export function parseAccountUsage(result: unknown): AccountUsage {
  const data = (result ?? {}) as Record<string, any>;
  const summary = (data.summary ?? {}) as Record<string, any>;
  const favorite = (summary.favoriteModel ?? {}) as Record<string, any>;

  const days: AccountUsageDay[] = [];
  const weeks = data.heatmap?.weeks;
  if (Array.isArray(weeks)) {
    for (const week of weeks) {
      if (!Array.isArray(week?.days)) continue;
      for (const day of week.days) {
        if (day && typeof day.date === "string") {
          days.push({ date: day.date, tokens: num(day.totalTokens), turns: num(day.turnCount) });
        }
      }
    }
  }

  return {
    range: typeof data.range === "string" ? data.range : null,
    summary: {
      totalTokens: num(summary.totalTokens),
      inputTokens: num(summary.inputTokens),
      outputTokens: num(summary.outputTokens),
      cacheReadTokens: num(summary.cacheReadTokens),
      cacheHitRate: typeof summary.cacheHitRate === "number" ? summary.cacheHitRate : null,
      totalSessions: typeof summary.totalSessions === "number" ? summary.totalSessions : null,
      totalTurns: typeof summary.totalTurns === "number" ? summary.totalTurns : null,
      toolCallCount: typeof summary.toolCallCount === "number" ? summary.toolCallCount : null,
      favoriteModel: typeof favorite.modelId === "string" ? favorite.modelId : null,
      favoriteModelShare: typeof favorite.share === "number" ? favorite.share : null,
    },
    days,
  };
}

// The last `days` non-null days of the heatmap, with each bar's height level
// (0..1) relative to the busiest of those days.
export function dailyBars(
  result: unknown,
  days: number,
): { date: string; tokens: number; level: number }[] {
  const all = parseAccountUsage(result).days.slice(-Math.max(0, days));
  const max = Math.max(1, ...all.map((day) => day.tokens));
  return all.map((day) => ({
    date: day.date,
    tokens: day.tokens,
    level: Math.min(1, Math.max(0, day.tokens / max)),
  }));
}
