import React from "react";
import { StyleSheet, TextInput, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { radius, useTheme } from "../theme";
import { PressScale } from "./PressScale";
import { Text } from "./Text";

interface ComposerProps {
  value: string;
  onChangeText: (text: string) => void;
  onSend: () => void;
  onStop: () => void;
  running: boolean;
  // chat computes it: text or ready attachments present, not mid-send
  canSend: boolean;
  sendDisabled?: boolean;
  autoFocus?: boolean;
  placeholder?: string;
  onAddPress?: () => void;
  modeLabel?: string | null;
  onPermissionPress?: () => void;
}

// Sticky composer: "+" (attachments), permission pill, surface field with a
// 36 px accent send circle (stop while running). Light haptic on send.
export function Composer({
  value,
  onChangeText,
  onSend,
  onStop,
  running,
  canSend,
  sendDisabled = false,
  autoFocus,
  placeholder = "Message ZCode",
  onAddPress,
  modeLabel,
  onPermissionPress,
}: ComposerProps) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const sendActive = running || (canSend && !sendDisabled);
  return (
    <View
      style={[
        styles.wrap,
        { backgroundColor: t.colors.bg, borderTopColor: t.colors.border, paddingBottom: insets.bottom + 8 },
      ]}
    >
      <View style={styles.controls}>
        {onAddPress ? (
          <PressScale
            onPress={onAddPress}
            accessibilityRole="button"
            accessibilityLabel="Add attachment"
            style={[styles.roundButton, { backgroundColor: t.colors.muted }]}
          >
            <Feather name="plus" size={18} color={t.colors.text} />
          </PressScale>
        ) : undefined}
        {modeLabel && onPermissionPress ? (
          <PressScale
            onPress={onPermissionPress}
            accessibilityRole="button"
            accessibilityLabel={`Permission: ${modeLabel}`}
            style={[styles.modePill, { backgroundColor: t.colors.muted }]}
          >
            <Text
              numberOfLines={1}
              style={{
                color: modeLabel === "Full access" ? t.colors.warn : t.colors.subtext,
                fontWeight: "600",
                fontSize: 12,
              }}
            >
              {modeLabel}
            </Text>
          </PressScale>
        ) : undefined}
      </View>
      <View style={[styles.field, { backgroundColor: t.colors.surface, borderColor: t.colors.border }]}>
        <TextInput
          style={[styles.input, { color: t.colors.text }]}
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={t.colors.subtext}
          multiline
          autoFocus={autoFocus}
        />
        <PressScale
          onPress={() => {
            if (running) {
              onStop();
              return;
            }
            if (!canSend || sendDisabled) return;
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            onSend();
          }}
          disabled={!running && (!canSend || sendDisabled)}
          accessibilityRole="button"
          accessibilityLabel={running ? "Stop" : "Send message"}
          style={[
            styles.action,
            {
              backgroundColor: t.colors.accent,
              opacity: !running && (!canSend || sendDisabled) ? 0.4 : 1,
            },
          ]}
        >
          <Feather name={running ? "square" : "arrow-up"} size={18} color={t.colors.onAccent} />
        </PressScale>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 8,
    paddingHorizontal: 20,
  },
  controls: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 6,
    minHeight: 28,
  },
  roundButton: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  modePill: {
    minHeight: 28,
    borderRadius: 999,
    paddingHorizontal: 10,
    alignItems: "center",
    justifyContent: "center",
    maxWidth: 110,
  },
  field: {
    flexDirection: "row",
    alignItems: "flex-end",
    borderRadius: radius.composer,
    borderWidth: StyleSheet.hairlineWidth,
    paddingLeft: 16,
    paddingRight: 8,
    paddingTop: 6,
    paddingBottom: 6,
    gap: 8,
  },
  input: {
    flex: 1,
    fontSize: 16,
    lineHeight: 22,
    maxHeight: 150,
    paddingTop: 6,
    paddingBottom: 6,
  },
  action: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 2,
  },
});
