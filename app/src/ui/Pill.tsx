import React from "react";
import { StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import { useTheme } from "../theme";
import { PressScale } from "./PressScale";
import { Text } from "./Text";

interface PillProps {
  label: string;
  onPress: () => void;
  variant?: "primary" | "quiet";
  disabled?: boolean;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
}

// Rounded-999 button. Primary: `accent` fill with `onAccent` label; quiet:
// bordered, accent label. Springs on press.
export function Pill({
  label,
  onPress,
  variant = "primary",
  disabled,
  accessibilityLabel,
  style,
}: PillProps) {
  const t = useTheme();
  const primary = variant === "primary";
  return (
    <PressScale
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      style={({ pressed }) => [
        styles.pill,
        primary
          ? { backgroundColor: t.colors.accent }
          : { borderWidth: StyleSheet.hairlineWidth, borderColor: t.colors.border },
        disabled ? { opacity: 0.4 } : undefined,
        pressed ? { opacity: 0.7 } : undefined,
        style,
      ]}
    >
      <Text variant="button" color={primary ? "onAccent" : "accent"}>
        {label}
      </Text>
    </PressScale>
  );
}

const styles = StyleSheet.create({
  pill: {
    minHeight: 48,
    borderRadius: 999,
    paddingHorizontal: 24,
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "flex-start",
  },
});
