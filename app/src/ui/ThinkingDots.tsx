import React, { useEffect, useRef } from "react";
import { Animated, Easing, StyleSheet, View } from "react-native";
import { useTheme } from "../theme";
import { useReduceMotion } from "./Dot";

// Three 3 px dots (3.5 px apart) fading 0.3 → 1 → 0.3 over 1.9 s, each
// started 0.15 s after the previous one. Static when Reduce Motion is on.
export function ThinkingDots() {
  const t = useTheme();
  const reduceMotion = useReduceMotion();
  const values = useRef([
    new Animated.Value(0.3),
    new Animated.Value(0.3),
    new Animated.Value(0.3),
  ]).current;

  useEffect(() => {
    if (reduceMotion) {
      values.forEach((value) => value.setValue(1));
      return;
    }
    const loops = values.map((value, index) =>
      Animated.sequence([
        Animated.delay(index * 150),
        Animated.loop(
          Animated.sequence([
            Animated.timing(value, {
              toValue: 1,
              duration: 950,
              easing: Easing.inOut(Easing.quad),
              useNativeDriver: true,
            }),
            Animated.timing(value, {
              toValue: 0.3,
              duration: 950,
              easing: Easing.inOut(Easing.quad),
              useNativeDriver: true,
            }),
          ]),
        ),
      ]),
    );
    Animated.parallel(loops).start();
    return () => {
      loops.forEach((animation) => animation.stop());
    };
  }, [reduceMotion, values]);

  return (
    <View style={styles.row} accessible={false} importantForAccessibility="no">
      {values.map((value, index) => (
        <Animated.View
          key={index}
          style={[styles.dot, { backgroundColor: t.colors.subtext, opacity: value }]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 3.5 },
  dot: { width: 3, height: 3, borderRadius: 1.5 },
});
