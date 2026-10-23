import React from "react";
import { StyleSheet, View, type PressableProps } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useTheme } from "../theme";
import { projectName, statusInfo } from "../sessionStatus";
import { Pill } from "./Pill";
import { PressScale } from "./PressScale";
import { StatusLight } from "./StatusLight";
import { Text } from "./Text";
import { ThinkingDots } from "./ThinkingDots";

// The approval strip a card shows when the session has a pending Ask-first
// request: one summary line (or the question note) plus Allow once / Deny.
export interface SessionCardApproval {
  summary: string;
  question: boolean;
  moreCount: number;
  busy: boolean;
  note?: string;
}

interface SessionCardProps {
  folder: string;
  status: string;
  timeLabel: string;
  showChevron?: boolean;
  approval?: SessionCardApproval;
  onAllow?: () => void;
  onDeny?: () => void;
  onPress: () => void;
  onLongPress?: () => void;
  accessibilityActions?: PressableProps["accessibilityActions"];
  onAccessibilityAction?: PressableProps["onAccessibilityAction"];
  accessibilityLabel: string;
}

// One home card: status light, project name over the plain-words status,
// relative time on the right — plus a chevron on needs-you rows, and the
// approval strip under the title when a request is waiting. Long press opens
// the archive sheet (see the home screen).
export function SessionCard({
  folder,
  status,
  timeLabel,
  showChevron = false,
  approval,
  onAllow,
  onDeny,
  onPress,
  onLongPress,
  accessibilityActions,
  onAccessibilityAction,
  accessibilityLabel,
}: SessionCardProps) {
  const t = useTheme();
  const info = statusInfo(status);
  const lightColor = info.light === "accent" ? t.colors.accent : t.colors[info.light];
  return (
    <PressScale
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityActions={accessibilityActions}
      onAccessibilityAction={onAccessibilityAction}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={[styles.card, { backgroundColor: t.colors.surface }]}
    >
      <View style={styles.topRow}>
        <StatusLight color={lightColor} pulse={info.light === "accent"} />
        <View style={styles.body}>
          <Text numberOfLines={1} style={styles.title}>
            {projectName(folder)}
          </Text>
          <View style={styles.subtitleRow}>
            <Text numberOfLines={1} color="subtext" style={styles.subtitle}>
              {info.word}
            </Text>
            {status === "running" ? <ThinkingDots /> : undefined}
          </View>
        </View>
        <Text color="subtext" style={styles.time}>
          {timeLabel}
        </Text>
        {showChevron ? (
          <Feather name="chevron-right" size={16} color={t.colors.subtext} />
        ) : undefined}
      </View>
      {approval ? (
        <View style={styles.approval}>
          {approval.question ? (
            <Text variant="caption" color="warn" numberOfLines={1}>
              Needs an answer. Open to read it.
            </Text>
          ) : (
            <>
              <Text variant="caption" color="subtext" numberOfLines={1}>
                {approval.summary}
              </Text>
              {approval.note ? (
                <Text variant="caption" color="subtext">
                  {approval.note}
                </Text>
              ) : onAllow && onDeny ? (
                <View style={styles.approvalButtons}>
                  <Pill
                    label="Allow once"
                    onPress={onAllow}
                    disabled={approval.busy}
                    style={styles.approvalButton}
                    accessibilityLabel="Allow once"
                  />
                  <Pill
                    label="Deny"
                    variant="quiet"
                    onPress={onDeny}
                    disabled={approval.busy}
                    style={styles.approvalButton}
                    accessibilityLabel="Deny this request"
                  />
                </View>
              ) : undefined}
              {approval.moreCount > 0 ? (
                <Text variant="caption" color="subtext">{`+${approval.moreCount} more`}</Text>
              ) : undefined}
            </>
          )}
        </View>
      ) : undefined}
    </PressScale>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 18,
    paddingVertical: 11,
    paddingLeft: 16,
    paddingRight: 14,
    minHeight: 56,
  },
  topRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
  },
  body: { flex: 1 },
  title: { fontSize: 15, lineHeight: 20, fontWeight: "600" },
  subtitleRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  subtitle: { fontSize: 12.5, lineHeight: 17 },
  time: {
    fontSize: 12.5,
    lineHeight: 17,
    marginLeft: 8,
    fontVariant: ["tabular-nums"],
  },
  approval: { marginTop: 8, gap: 6 },
  approvalButtons: { flexDirection: "row", gap: 8 },
  approvalButton: { minHeight: 44, paddingHorizontal: 16 },
});
