import React from "react";
import { StyleSheet, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useTheme } from "../theme";
import { projectName, statusInfo } from "../sessionStatus";
import { PressScale } from "./PressScale";
import { StatusLight } from "./StatusLight";
import { Text } from "./Text";
import { ThinkingDots } from "./ThinkingDots";

interface SessionCardProps {
  folder: string;
  status: string;
  timeLabel: string;
  showChevron?: boolean;
  onPress: () => void;
  accessibilityLabel: string;
}

// One home card: status light, project name over the plain-words status,
// relative time on the right — plus a chevron on needs-you rows.
export function SessionCard({
  folder,
  status,
  timeLabel,
  showChevron = false,
  onPress,
  accessibilityLabel,
}: SessionCardProps) {
  const t = useTheme();
  const info = statusInfo(status);
  const lightColor = info.light === "accent" ? t.colors.accent : t.colors[info.light];
  return (
    <PressScale
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={[styles.card, { backgroundColor: t.colors.surface }]}
    >
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
    </PressScale>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    borderRadius: 18,
    paddingVertical: 11,
    paddingLeft: 16,
    paddingRight: 14,
    minHeight: 56,
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
});
