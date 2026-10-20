import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useTheme } from "../theme";
import { dailyBars, formatPercent, formatTokens, parseAccountUsage, parseSessionUsage, type AccountUsage } from "../usage";
import { PressScale } from "./PressScale";
import { Skeleton } from "./Skeleton";
import { Sheet } from "./Sheet";
import { Text } from "./Text";

type Range = "7d" | "30d" | "all";

const RANGES: { key: Range; label: string }[] = [
  { key: "7d", label: "7 days" },
  { key: "30d", label: "30 days" },
  { key: "all", label: "All" },
];

interface UsageSheetProps {
  visible: boolean;
  onClose: () => void;
  // Present when opened from a chat; absent for the account-only home sheet.
  conversation?: {
    contextUsed: number | null;
    contextWindow: number | null;
  } | null;
  fetchSessionUsage?: () => Promise<unknown>;
  fetchAccountUsage: (range: Range) => Promise<unknown>;
}

function UsageLine({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.line}>
      <Text variant="rowSubtitle" color="subtext">
        {label}
      </Text>
      <Text variant="rowSubtitle" style={styles.lineValue}>
        {value}
      </Text>
    </View>
  );
}

export function UsageSheet({
  visible,
  onClose,
  conversation,
  fetchSessionUsage,
  fetchAccountUsage,
}: UsageSheetProps) {
  const t = useTheme();
  const [range, setRange] = useState<Range>("7d");
  const [sessionUsage, setSessionUsage] = useState<ReturnType<typeof parseSessionUsage> | null>(
    null,
  );
  const [account, setAccount] = useState<AccountUsage | null>(null);
  const [accountRaw, setAccountRaw] = useState<unknown>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const attempt = useRef(0);

  const load = useCallback(async () => {
    const current = (attempt.current += 1);
    setState("loading");
    try {
      const [sessionResult, accountResult] = await Promise.all([
        fetchSessionUsage ? fetchSessionUsage() : Promise.resolve(null),
        fetchAccountUsage(range),
      ]);
      if (current !== attempt.current) return;
      setSessionUsage(sessionResult === null ? null : parseSessionUsage(sessionResult));
      setAccount(parseAccountUsage(accountResult));
      setAccountRaw(accountResult);
      setState("ready");
    } catch {
      if (current !== attempt.current) return;
      setState("error");
    }
  }, [fetchSessionUsage, fetchAccountUsage, range]);

  useEffect(() => {
    if (visible) void load();
  }, [visible, load]);

  const bars = useMemo(() => dailyBars(accountRaw, 14), [accountRaw]);
  const todayKey = new Date().toISOString().slice(0, 10);

  const context = conversation ?? null;
  const contextBar =
    context && context.contextWindow && context.contextWindow > 0
      ? {
          percent: Math.min(
            100,
            Math.max(0, Math.round(((context.contextUsed ?? 0) / context.contextWindow) * 100)),
          ),
          caption: `${formatTokens(context.contextUsed ?? 0)} of ${formatTokens(
            context.contextWindow,
          )} context`,
        }
      : null;

  return (
    <Sheet visible={visible} onClose={onClose}>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        <Text variant="display" style={{ fontSize: 22, lineHeight: 28 }}>
          Usage
        </Text>

        {contextBar ? (
          <>
            <Text variant="sectionHeader" color="subtext" style={styles.section}>
              This conversation
            </Text>
            <View style={[styles.track, { backgroundColor: t.colors.muted }]}>
              <View
                style={[
                  styles.trackFill,
                  { width: `${contextBar.percent}%` as const, backgroundColor: t.colors.accent },
                ]}
              />
            </View>
            <Text variant="caption" color="subtext" style={styles.trackCaption}>
              {contextBar.caption}
            </Text>
          </>
        ) : undefined}

        {sessionUsage ? (
          <View style={{ marginTop: 12 }}>
            <UsageLine label="Input" value={formatTokens(sessionUsage.inputTokens)} />
            <UsageLine label="Output" value={formatTokens(sessionUsage.outputTokens)} />
            <UsageLine label="Cache read" value={formatTokens(sessionUsage.cacheReadTokens)} />
            <UsageLine label="Requests" value={String(sessionUsage.modelRequestCount)} />
          </View>
        ) : undefined}

        <Text variant="sectionHeader" color="subtext" style={styles.section}>
          Account
        </Text>
        <View style={styles.ranges}>
          {RANGES.map((option) => {
            const current = option.key === range;
            return (
              <View key={option.key} style={styles.rangeSlot}>
              <PressScale
                onPress={() => setRange(option.key)}
                accessibilityRole="button"
                accessibilityLabel={`${option.label} usage${current ? ", current" : ""}`}
                style={[
                  styles.range,
                  { backgroundColor: current ? t.colors.accent : t.colors.muted },
                ]}
              >
                <Text
                  style={{
                    color: current ? t.colors.onAccent : t.colors.text,
                    fontWeight: "600",
                    fontSize: 13,
                  }}
                >
                  {option.label}
                </Text>
              </PressScale>
              </View>
            );
          })}
        </View>

        {state === "loading" ? <Skeleton /> : undefined}
        {state === "error" ? (
          <View style={styles.errorRow}>
            <Text variant="bodySmall" color="danger">
              Could not load usage
            </Text>
            <Pressable
              onPress={() => void load()}
              accessibilityRole="button"
              accessibilityLabel="Retry"
              hitSlop={8}
            >
              <Text variant="bodySmall" color="accent" style={{ fontWeight: "600" }}>
                Retry
              </Text>
            </Pressable>
          </View>
        ) : undefined}
        {state === "ready" && account ? (
          <>
            <Text variant="display" style={styles.total}>
              {formatTokens(account.summary.totalTokens)}
            </Text>
            <Text variant="caption" color="subtext">
              total tokens
            </Text>
            <View style={{ marginTop: 12 }}>
              <UsageLine label="Sessions" value={String(account.summary.totalSessions ?? "—")} />
              <UsageLine label="Turns" value={String(account.summary.totalTurns ?? "—")} />
              <UsageLine
                label="Cache hit rate"
                value={
                  account.summary.cacheHitRate === null
                    ? "—"
                    : formatPercent(account.summary.cacheHitRate)
                }
              />
              <UsageLine
                label="Favorite model"
                value={
                  account.summary.favoriteModel === null
                    ? "—"
                    : `${account.summary.favoriteModel}${
                        account.summary.favoriteModelShare === null
                          ? ""
                          : ` · ${formatPercent(account.summary.favoriteModelShare)}`
                      }`
                }
              />
            </View>
            {bars.length > 0 ? (
              <>
                <Text variant="sectionHeader" color="subtext" style={styles.section}>
                  Last {bars.length} days
                </Text>
                <View style={styles.chart}>
                  <View style={styles.chartBars}>
                  {bars.map((bar, index) => (
                    <View
                      key={bar.date}
                      style={[
                        styles.chartBar,
                        {
                          height: Math.max(4, Math.round(bar.level * 48)),
                          backgroundColor:
                            bar.date === todayKey ? t.colors.accent : t.colors.muted,
                        },
                      ]}
                    />
                  ))}
                  </View>
                </View>
                <View style={styles.chartDates}>
                  <Text variant="caption" color="subtext">
                    {bars[0]?.date}
                  </Text>
                  <Text variant="caption" color="subtext">
                    {bars[bars.length - 1]?.date}
                  </Text>
                </View>
              </>
            ) : undefined}
          </>
        ) : undefined}
      </ScrollView>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  scroll: { maxHeight: 480 },
  scrollContent: { paddingBottom: 8 },
  section: { marginTop: 20 },
  track: { height: 6, borderRadius: 3, marginTop: 4 },
  trackFill: { height: 6, borderRadius: 3 },
  trackCaption: { marginTop: 6 },
  ranges: { flexDirection: "row", gap: 8 },
  rangeSlot: { flex: 1 },
  range: {
    alignSelf: "stretch",
    minHeight: 40,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
  },
  errorRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12 },
  total: { marginTop: 8 },
  line: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 4,
  },
  lineValue: { fontVariant: ["tabular-nums"] },
  chart: { marginTop: 4 },
  chartBars: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 3,
    height: 52,
  },
  chartBar: { flex: 1, borderRadius: 3 },
  chartDates: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 6,
  },
});
