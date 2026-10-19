import React, { useState } from "react";
import { LayoutAnimation, Pressable, StyleSheet, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { radius, useTheme } from "../theme";
import { useReduceMotion } from "./Dot";
import { Text } from "./Text";

const OUTPUT_LIMIT = 600;

// Expand/collapse animates via LayoutAnimation (skipped under Reduce Motion).
function configureExpand(reduceMotion: boolean) {
  if (reduceMotion) return;
  LayoutAnimation.configureNext({
    duration: 200,
    update: { type: LayoutAnimation.Types.easeInEaseOut },
    create: { type: LayoutAnimation.Types.easeInEaseOut, property: LayoutAnimation.Properties.opacity },
  });
}

interface ToolRowProps {
  name: string;
  // one-line mono summary: file path, command, or state
  summary?: string;
  input?: string;
  output?: string;
}

// "▸ Read src/router.ts" — one muted line; tap to expand input/output in a
// muted mono block. Output is cut at 600 characters with a Show more toggle.
export function ToolRow({ name, summary, input, output }: ToolRowProps) {
  const t = useTheme();
  const reduceMotion = useReduceMotion();
  const [open, setOpen] = useState(false);
  const [showAllOutput, setShowAllOutput] = useState(false);
  const expandable = Boolean(input || output);
  const outputCut = Boolean(output && output.length > OUTPUT_LIMIT);
  const shownOutput = outputCut && !showAllOutput ? output?.slice(0, OUTPUT_LIMIT) : output;
  return (
    <View style={styles.wrap}>
      <Pressable
        disabled={!expandable}
        onPress={() => {
          configureExpand(reduceMotion);
          setOpen(!open);
        }}
        accessibilityRole={expandable ? "button" : "text"}
        accessibilityLabel={`Tool ${name}${summary ? `: ${summary}` : ""}`}
        style={styles.line}
      >
        {expandable ? (
          <Feather name={open ? "chevron-down" : "chevron-right"} size={16} color={t.colors.subtext} />
        ) : (
          <Feather name="chevron-right" size={16} color={t.colors.subtext} />
        )}
        <Text variant="mono" numberOfLines={1} style={{ fontWeight: "600" }}>
          {name}
        </Text>
        {summary ? (
          <Text variant="mono" color="subtext" numberOfLines={1} style={{ flex: 1 }}>
            {summary}
          </Text>
        ) : undefined}
      </Pressable>
      {open && expandable ? (
        <View style={[styles.block, { backgroundColor: t.colors.muted }]}>
          {input ? (
            <Text variant="mono" selectable>
              {input}
            </Text>
          ) : undefined}
          {output ? (
            <>
              <Text variant="mono" selectable>
                {shownOutput}
                {outputCut && !showAllOutput ? "…" : ""}
              </Text>
              {outputCut ? (
                <Text
                  variant="mono"
                  color="accent"
                  onPress={() => setShowAllOutput(!showAllOutput)}
                  style={styles.showMore}
                >
                  {showAllOutput ? "Show less" : "Show more"}
                </Text>
              ) : undefined}
            </>
          ) : undefined}
        </View>
      ) : undefined}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginVertical: 2 },
  line: { minHeight: 32, flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 4 },
  block: { borderRadius: radius.code, padding: 12, marginTop: 4, gap: 4 },
  showMore: { marginTop: 4, fontWeight: "600" },
});
