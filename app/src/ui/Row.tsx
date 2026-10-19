import React, { useRef } from "react";
import { Animated, Pressable, StyleSheet, View } from "react-native";
import { useTheme } from "../theme";
import { Text } from "./Text";

interface RowProps {
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
  onPress?: () => void;
  accessibilityLabel?: string;
}

// List row: title + optional subtitle + optional right node (status dot,
// check icon). The pressed state fades to the muted background in 150 ms.
export function Row({ title, subtitle, right, onPress, accessibilityLabel }: RowProps) {
  const t = useTheme();
  const fade = useRef(new Animated.Value(0)).current;
  const animate = (toValue: number) =>
    Animated.timing(fade, { toValue, duration: 150, useNativeDriver: true }).start();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      onPressIn={() => animate(1)}
      onPressOut={() => animate(0)}
      style={styles.pressable}
    >
      <Animated.View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          { backgroundColor: t.colors.muted, opacity: fade, borderRadius: 12 },
        ]}
      />
      <View style={styles.flex}>
        <Text variant="rowTitle" numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text variant="rowSubtitle" color="subtext" numberOfLines={1} style={{ marginTop: 2 }}>
            {subtitle}
          </Text>
        ) : undefined}
      </View>
      {right}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pressable: {
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 8,
  },
  flex: { flex: 1 },
});
