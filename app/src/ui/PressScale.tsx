import React, { useRef } from "react";
import { Animated, Pressable, StyleSheet, type PressableProps, type StyleProp, type ViewStyle } from "react-native";
import { useReduceMotion } from "./Dot";

interface PressScaleProps extends Omit<PressableProps, "style" | "children"> {
  style?: StyleProp<ViewStyle> | ((state: { pressed: boolean }) => StyleProp<ViewStyle>);
  children?: React.ReactNode | ((state: { pressed: boolean }) => React.ReactNode);
}

// Pressable wrapper that springs the content to 0.98 on press and back on
// release (stiffness 600, damping 30, mass 1). Reduce Motion keeps the
// pressed background change but skips the scale.
export function PressScale({ children, style, onPressIn, onPressOut, ...rest }: PressScaleProps) {
  const reduceMotion = useReduceMotion();
  const scale = useRef(new Animated.Value(1)).current;
  const spring = (toValue: number) =>
    Animated.spring(scale, {
      toValue,
      stiffness: 600,
      damping: 30,
      mass: 1,
      useNativeDriver: true,
    }).start();

  return (
    <Pressable
      {...rest}
      onPressIn={(event) => {
        if (!reduceMotion) spring(0.98);
        onPressIn?.(event);
      }}
      onPressOut={(event) => {
        if (!reduceMotion) spring(1);
        onPressOut?.(event);
      }}
    >
      {({ pressed }) => (
        <Animated.View
          style={[
            typeof style === "function" ? style({ pressed }) : style,
            styles.content,
            { transform: [{ scale }] },
          ]}
        >
          {typeof children === "function" ? children({ pressed }) : children}
        </Animated.View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  content: {},
});
