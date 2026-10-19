import React, { useEffect, useRef } from "react";
import { Animated } from "react-native";

interface DotProps {
  color: string;
  size?: number;
  // 0.35 → 1 opacity loop over 900 ms, per DESIGN.md §2 motion.
  pulse?: boolean;
}

export function Dot({ color, size = 8, pulse = false }: DotProps) {
  const opacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!pulse) return;
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.35, duration: 450, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 450, useNativeDriver: true }),
      ]),
    );
    animation.start();
    return () => animation.stop();
  }, [pulse, opacity]);
  return (
    <Animated.View
      style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color, opacity }}
    />
  );
}
