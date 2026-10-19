import React, { useEffect, useRef, useState } from "react";
import { Animated, Easing, StyleSheet, View } from "react-native";
import { useTheme } from "../theme";
import { useReduceMotion } from "./Dot";

const BAR_WIDTHS = ["90%", "74%", "58%"] as const;

// History-loading placeholder: three muted bars with a translucent band
// sweeping left to right every 2 s (static band hidden under Reduce Motion).
export function Skeleton() {
  const t = useTheme();
  const reduceMotion = useReduceMotion();
  const sweep = useRef(new Animated.Value(0)).current;
  const [width, setWidth] = useState(320);

  useEffect(() => {
    if (reduceMotion) return;
    const animation = Animated.loop(
      Animated.timing(sweep, {
        toValue: 1,
        duration: 2000,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    animation.start();
    return () => animation.stop();
  }, [reduceMotion, sweep]);

  const translateX = sweep.interpolate({
    inputRange: [0, 1],
    outputRange: [-80, width + 80],
  });

  return (
    <View
      style={styles.wrap}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      accessibilityLabel="Loading history"
    >
      {BAR_WIDTHS.map((barWidth) => (
        <View
          key={barWidth}
          style={[styles.bar, { width: barWidth, backgroundColor: t.colors.muted }]}
        />
      ))}
      {reduceMotion ? undefined : (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.band,
            { backgroundColor: t.colors.bg, transform: [{ translateX }] },
          ]}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingTop: 8, overflow: "hidden" },
  bar: { height: 14, borderRadius: 7, marginTop: 14 },
  band: {
    ...StyleSheet.absoluteFill,
    top: 0,
    width: 60,
    opacity: 0.5,
  },
});
