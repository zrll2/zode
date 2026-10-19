import React from "react";
import { StyleSheet, Text as RNText, type TextProps } from "react-native";
import { useTheme, type ThemeColorName } from "../theme";

export type TextVariant =
  | "display"
  | "sectionHeader"
  | "rowTitle"
  | "rowSubtitle"
  | "body"
  | "bodySmall"
  | "mono"
  | "button"
  | "caption";

interface OwnProps extends TextProps {
  variant?: TextVariant;
  color?: ThemeColorName;
}

// Typography per DESIGN.md §2: serif display, system sans everything else,
// monospace for code and tool text.
export function Text({ variant = "body", color, style, ...rest }: OwnProps) {
  const t = useTheme();
  return (
    <RNText
      {...rest}
      style={[
        styles[variant],
        variant === "display" ? { fontFamily: t.fonts.serif } : undefined,
        variant === "mono" ? { fontFamily: t.fonts.mono } : undefined,
        { color: t.colors.text },
        color ? { color: t.colors[color] } : undefined,
        style,
      ]}
    />
  );
}

const styles = StyleSheet.create({
  display: { fontSize: 30, lineHeight: 36, fontWeight: "500" },
  sectionHeader: { fontSize: 13, lineHeight: 18, fontWeight: "600" },
  rowTitle: { fontSize: 17, lineHeight: 22, fontWeight: "500" },
  rowSubtitle: { fontSize: 14, lineHeight: 20 },
  body: { fontSize: 16, lineHeight: 25 },
  bodySmall: { fontSize: 15, lineHeight: 23 },
  mono: { fontSize: 13.5, lineHeight: 20 },
  button: { fontSize: 16, lineHeight: 20, fontWeight: "600" },
  caption: { fontSize: 12, lineHeight: 16 },
});
