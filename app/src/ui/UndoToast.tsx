import React, { useEffect, useRef } from "react";
import { Animated, Pressable, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../theme";
import { Text } from "./Text";

interface UndoToastProps {
  message: string | null;
  onUndo?: () => void; // absent → the toast shows the message only
}

// Bottom toast (home-list-v2: .toast): accent pill with the message and an
// underlined Undo, sitting clear of the floating + button. The screen owns
// the 3.2 s timer.
export function UndoToast({ message, onUndo }: UndoToastProps) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const visible = Boolean(message);
  const opacity = useRef(new Animated.Value(0)).current;
  const lift = useRef(new Animated.Value(8)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(opacity, { toValue: visible ? 1 : 0, duration: 200, useNativeDriver: true }),
      Animated.timing(lift, { toValue: visible ? 0 : 8, duration: 200, useNativeDriver: true }),
    ]).start();
  }, [visible, opacity, lift]);

  if (!message) return null;
  return (
    <Animated.View
      pointerEvents="box-none"
      style={[
        styles.toast,
        {
          backgroundColor: t.colors.accent,
          bottom: insets.bottom + 24,
          opacity,
          transform: [{ translateY: lift }],
        },
      ]}
      accessibilityLiveRegion="polite"
    >
      <Text style={[styles.message, { color: t.colors.onAccent }]} numberOfLines={1}>
        {message}
      </Text>
      {onUndo ? (
        <Pressable
          onPress={onUndo}
          accessibilityRole="button"
          accessibilityLabel="Undo"
          hitSlop={8}
        >
          <Text style={[styles.undo, { color: t.colors.onAccent }]}>Undo</Text>
        </Pressable>
      ) : undefined}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  toast: {
    position: "absolute",
    left: 16,
    right: 90,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  message: { flex: 1, fontSize: 13, lineHeight: 18 },
  undo: { fontSize: 13, lineHeight: 18, fontWeight: "700", textDecorationLine: "underline" },
});
