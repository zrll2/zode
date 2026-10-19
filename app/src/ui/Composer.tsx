import React from "react";
import { StyleSheet, TextInput, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { radius, useTheme } from "../theme";
import { PressScale } from "./PressScale";

interface ComposerProps {
  value: string;
  onChangeText: (text: string) => void;
  onSend: () => void;
  onStop: () => void;
  running: boolean;
  sending?: boolean;
  autoFocus?: boolean;
  placeholder?: string;
}

// Sticky composer: surface field, radius 26, grows to 6 lines. The send
// circle is accent with an arrow-up; while running it becomes a `text`
// circle with a square (stop). Light haptic on send.
export function Composer({
  value,
  onChangeText,
  onSend,
  onStop,
  running,
  sending,
  autoFocus,
  placeholder = "Message ZCode",
}: ComposerProps) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const canSend = value.trim().length > 0 && !sending;
  return (
    <View
      style={[
        styles.wrap,
        { backgroundColor: t.colors.bg, borderTopColor: t.colors.border, paddingBottom: insets.bottom + 8 },
      ]}
    >
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
            if (!canSend) return;
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            onSend();
          }}
          disabled={!running && !canSend}
          accessibilityRole="button"
          accessibilityLabel={running ? "Stop" : "Send message"}
          style={[
            styles.action,
            {
              backgroundColor: t.colors.accent,
              opacity: !running && !canSend ? 0.4 : 1,
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
