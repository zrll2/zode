import React from "react";
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { withAlpha, type HomeItem } from "../homeList";
import { useTheme } from "../theme";
import type { ApprovalRequest } from "../approvals";
import { Text } from "./Text";

// The mock's small rounded action button (.btn/.btn.pri): 13 px semibold,
// radius 9, min height 36. Primary is accent-filled.
export function ActionButton({
  label,
  onPress,
  variant = "primary",
  disabled,
  accessibilityLabel,
  style,
}: {
  label: string;
  onPress: () => void;
  variant?: "primary" | "quiet";
  disabled?: boolean;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const t = useTheme();
  const primary = variant === "primary";
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      style={({ pressed }) => [
        styles.action,
        primary
          ? { backgroundColor: t.colors.accent }
          : { backgroundColor: t.colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: t.colors.border },
        disabled || pressed ? { opacity: 0.5 } : undefined,
        style,
      ]}
    >
      <Text style={{ fontSize: 13, lineHeight: 18, fontWeight: "600", color: primary ? t.colors.onAccent : t.colors.text }}>
        {label}
      </Text>
    </Pressable>
  );
}

interface NeedCardProps {
  item: HomeItem; // kind "waiting" | "failed"
  ask: ApprovalRequest | null; // oldest pending permission request
  askMore: number; // further pending requests behind the oldest
  busy: boolean;
  note?: string;
  last?: boolean; // no hairline below the final card in the group
  onAllow?: () => void;
  onDeny?: () => void;
  onOpen: () => void;
}

// One tinted Needs-you card (home-list-v2: .need): project and state on the
// first line, the conversation title under it, then — for a pending
// permission request — the command in mono with Allow once / Deny (P3
// behaviour, confirm included), and for a failed conversation the calm
// failure line with Open. Tapping the card body opens the chat.
export function NeedCard({
  item,
  ask,
  askMore,
  busy,
  note,
  last = false,
  onAllow,
  onDeny,
  onOpen,
}: NeedCardProps) {
  const t = useTheme();
  const failed = item.kind === "failed";
  const tint = withAlpha(failed ? t.colors.danger : t.colors.warn, failed ? 0.12 : 0.16);
  // item.time is "now", "9 min", "1 h", "Yesterday" or a date like "Oct 20": only the first three read as a duration.
  const isDuration = item.time === "now" || /^\d+ (min|h)$/.test(item.time);
  const stateLabel = failed
    ? item.time === "now"
      ? "failed just now"
      : isDuration
        ? `failed ${item.time} ago`
        : `failed ${item.time}`
    : `waiting ${item.time}`;
  return (
    <View
      style={[
        styles.card,
        last ? undefined : { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: t.colors.border },
        { backgroundColor: tint },
      ]}
    >
      <Pressable
        onPress={onOpen}
        accessibilityRole="button"
        accessibilityLabel={`${item.title}, ${item.project}, ${stateLabel}`}
      >
        <View style={styles.line1}>
          <Text style={[styles.project, { color: t.colors.text }]} numberOfLines={1}>
            {item.project}
          </Text>
          <Text style={[styles.meta, { color: t.colors.subtext }]}>{stateLabel}</Text>
        </View>
        <Text style={[styles.title, { color: t.colors.subtext }]} numberOfLines={1}>
          {item.title}
        </Text>
        {ask && ask.kind === "permission" ? (
          <View style={[styles.command, { backgroundColor: withAlpha(t.colors.text, 0.07) }]}>
            <Text selectable style={[styles.commandText, { color: t.colors.text }]}>
              {ask.summary}
            </Text>
          </View>
        ) : undefined}
        {ask && ask.kind === "question" ? (
          <Text style={[styles.noteText, { color: t.colors.subtext }]}>
            Needs an answer. Open to read it.
          </Text>
        ) : undefined}
        {failed ? (
          <Text style={[styles.noteText, { color: t.colors.subtext }]}>
            The last attempt failed.
          </Text>
        ) : undefined}
      </Pressable>
      {ask && ask.kind === "permission" && !note ? (
        <>
          <View style={styles.actions}>
            <ActionButton
              label="Allow once"
              onPress={() => onAllow?.()}
              disabled={busy || !onAllow}
            />
            <ActionButton
              label="Deny"
              variant="quiet"
              onPress={() => onDeny?.()}
              disabled={busy || !onDeny}
            />
          </View>
          {askMore > 0 ? (
            <Text style={[styles.more, { color: t.colors.subtext }]}>{`+${askMore} more`}</Text>
          ) : undefined}
        </>
      ) : undefined}
      {failed ? (
        <View style={styles.actions}>
          <ActionButton label="Open" onPress={onOpen} />
        </View>
      ) : undefined}
      {note ? (
        <Text style={[styles.more, { color: t.colors.subtext }]}>{note}</Text>
      ) : undefined}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { padding: 12, paddingHorizontal: 14 },
  line1: { flexDirection: "row", alignItems: "baseline", gap: 8 },
  project: { flex: 1, fontSize: 15, lineHeight: 20, fontWeight: "700" },
  meta: { fontSize: 12, lineHeight: 16, fontVariant: ["tabular-nums"] },
  title: { fontSize: 13, lineHeight: 18, marginTop: 1 },
  command: {
    marginTop: 8,
    marginBottom: 2,
    borderRadius: 8,
    paddingVertical: 7,
    paddingHorizontal: 9,
  },
  commandText: { fontSize: 12, lineHeight: 16 },
  noteText: { fontSize: 13, lineHeight: 18, marginTop: 6, marginBottom: 2 },
  actions: { flexDirection: "row", gap: 8, marginTop: 10 },
  action: { minHeight: 44, borderRadius: 12, paddingHorizontal: 16, alignItems: "center", justifyContent: "center" },
  more: { fontSize: 12, lineHeight: 16, marginTop: 6 },
});
