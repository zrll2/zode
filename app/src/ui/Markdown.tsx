import React, { useMemo } from "react";
import { StyleSheet } from "react-native";
import RNMarkdown from "react-native-markdown-display";
import { radius, useTheme, type ThemeColors } from "../theme";

// Assistant text as Markdown, styled only from theme tokens (DESIGN.md §3.2).
// Memoized per text so streaming one message does not re-render the others.
export const Markdown = React.memo(function Markdown({ children }: { children: string }) {
  const t = useTheme();
  const styles = useMemo(() => buildStyles(t.colors, t.fonts.mono), [t]);
  return <RNMarkdown style={styles as never}>{children}</RNMarkdown>;
});

function buildStyles(colors: ThemeColors, mono: string) {
  return {
    body: { color: colors.text, fontSize: 16, lineHeight: 25 },
    paragraph: { marginTop: 0, marginBottom: 12, fontSize: 16, lineHeight: 25 },
    heading1: { fontSize: 22, lineHeight: 28, fontWeight: "700", color: colors.text, marginTop: 8, marginBottom: 8 },
    heading2: { fontSize: 19, lineHeight: 25, fontWeight: "700", color: colors.text, marginTop: 8, marginBottom: 6 },
    heading3: { fontSize: 17, lineHeight: 23, fontWeight: "600", color: colors.text, marginTop: 8, marginBottom: 6 },
    strong: { fontWeight: "600", color: colors.text },
    em: { fontStyle: "italic", color: colors.text },
    link: { color: colors.text, textDecorationLine: "underline" },
    code_inline: {
      backgroundColor: colors.muted,
      color: colors.text,
      fontFamily: mono,
      fontSize: 13.5,
      lineHeight: 20,
      borderRadius: 4,
    },
    fence: {
      backgroundColor: colors.muted,
      borderColor: colors.muted,
      color: colors.text,
      fontFamily: mono,
      fontSize: 13.5,
      lineHeight: 20,
      borderRadius: radius.code,
    },
    blockquote: {
      backgroundColor: "transparent",
      borderLeftWidth: 3,
      borderLeftColor: colors.border,
      marginLeft: 0,
      marginVertical: 8,
      paddingHorizontal: 12,
      color: colors.subtext,
    },
    list_item: { marginVertical: 2 },
    bulleted_list_icon: { color: colors.subtext },
    ordered_list_icon: { color: colors.subtext },
    table: { borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
    th: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      padding: 6,
      backgroundColor: colors.muted,
      color: colors.text,
    },
    td: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      padding: 6,
      color: colors.text,
    },
    hr: { backgroundColor: colors.border },
  };
}
