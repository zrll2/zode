import React, { useEffect, useRef } from "react";
import { Animated, Easing, StyleSheet, View } from "react-native";
import { useTheme } from "../theme";
import { useReduceMotion } from "./Dot";

// Three 9 px accent dots pulsing in sequence — the centred connecting state
// on the home screen. Static at full opacity when Reduce Motion is on.
export function ConnectingDots() {
  const t = useTheme();
  const reduceMotion = useReduceMotion();
  const values = useRef([
    new Animated.Value(1),
    new Animated.Value(1),
    new Animated.Value(1),
  ]).current;

  useEffect(() => {
    if (reduceMotion) {
      values.forEach((value) => value.setValue(1));
      return;
    }
    // Stagger offsets each loop's start; the loops then stay in phase.
    const animation = Animated.stagger(
      180,
      values.map((value) =>
        Animated.loop(
          Animated.sequence([
            Animated.timing(value, {
              toValue: 0.3,
              duration: 420,
              easing: Easing.inOut(Easing.quad),
              useNativeDriver: true,
            }),
            Animated.timing(value, {
              toValue: 1,
              duration: 420,
              easing: Easing.inOut(Easing.quad),
              useNativeDriver: true,
            }),
          ]),
        ),
      ),
    );
    animation.start();
    return () => animation.stop();
  }, [reduceMotion, values]);

  return (
    <View style={styles.row} accessible={false} importantForAccessibility="no">
      {values.map((value, index) => (
        <Animated.View
          key={index}
          style={[styles.dot, { backgroundColor: t.colors.accent, opacity: value }]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  dot: { width: 9, height: 9, borderRadius: 4.5 },
});
