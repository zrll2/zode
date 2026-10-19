import React from "react";
import { StyleSheet, View } from "react-native";
import { Dot } from "./Dot";

// 10 px status light with a 3 px ring of the same color at 18 % opacity.
export function StatusLight({ color, pulse }: { color: string; pulse: boolean }) {
  return (
    <View style={styles.wrap} accessible={false} importantForAccessibility="no">
      <View style={[styles.ring, { borderColor: color }]} />
      <Dot color={color} size={10} pulse={pulse} />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { width: 16, height: 16, alignItems: "center", justifyContent: "center" },
  ring: {
    position: "absolute",
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 3,
    opacity: 0.18,
  },
});
