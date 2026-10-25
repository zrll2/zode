import React from "react";
import { StyleSheet, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useTheme } from "../theme";
import { PressScale } from "./PressScale";
import { Sheet } from "./Sheet";
import { Text } from "./Text";
export type PhoneMode = "plan" | "edit" | "guarded";

const OPTIONS: { mode: PhoneMode; title: string }[] = [
  { mode: "plan", title: "Read only" },
  { mode: "edit", title: "Edit files" },
  { mode: "guarded", title: "Ask first" },
];

interface PermissionSheetProps {
  visible: boolean;
  onClose: () => void;
  running: boolean;
  mode: string | null;
  onPick: (mode: PhoneMode) => void;
}

// Permission level sheet: the three phone-selectable modes.
export function PermissionSheet({ visible, onClose, running, mode, onPick }: PermissionSheetProps) {
  const t = useTheme();

  function pick(picked: PhoneMode) {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onPick(picked);
  }

  return (
    <Sheet visible={visible} onClose={onClose}>
      <Text variant="display" style={{ fontSize: 22, lineHeight: 28 }}>
        Permission
      </Text>
      {running ? (
        <Text variant="caption" color="warn">
          Stop to change
        </Text>
      ) : undefined}
      <View style={styles.group}>
        {OPTIONS.map((option) => {
          const current = option.mode === mode;
          return (
            <PressScale
              key={option.mode}
              disabled={running}
              onPress={() => pick(option.mode)}
              accessibilityRole="button"
              accessibilityLabel={`${option.title}${current ? ", current" : ""}`}
              style={[styles.row, { backgroundColor: t.colors.muted }]}
            >
              <View style={styles.flex}>
                <Text numberOfLines={1} style={styles.rowTitle}>
                  {option.title}
                </Text>
              </View>
              {current ? (
                <Feather name="check" size={18} color={t.colors.accent} />
              ) : undefined}
            </PressScale>
          );
        })}
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  group: { gap: 8, marginTop: 8 },
  row: {
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderRadius: 18,
    paddingHorizontal: 16,
    paddingVertical: 11,
  },
  flex: { flex: 1 },
  rowTitle: { fontSize: 15, lineHeight: 20, fontWeight: "600" },
});
