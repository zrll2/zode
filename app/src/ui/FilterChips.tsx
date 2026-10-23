import React from "react";
import { Pressable, ScrollView, StyleSheet } from "react-native";
import { useTheme } from "../theme";
import { Text } from "./Text";

interface FilterChipsProps {
  projects: string[]; // includes "All" first
  selected: string;
  onSelect: (project: string) => void;
}

// Project filter chips under the header (home-list-v2: .chips/.chip).
// Hidden while there is only one project — nothing to filter.
export function FilterChips({ projects, selected, onSelect }: FilterChipsProps) {
  const t = useTheme();
  if (projects.length <= 2) return null;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      style={styles.scroll}
      contentContainerStyle={styles.content}
    >
      {projects.map((project) => {
        const active = project === selected;
        return (
          <Pressable
            key={project}
            onPress={() => onSelect(project)}
            accessibilityRole="button"
            accessibilityLabel={`Filter by ${project}`}
            accessibilityState={{ selected: active }}
            hitSlop={4}
            style={[
              styles.chip,
              { backgroundColor: active ? t.colors.accent : t.colors.muted },
            ]}
          >
            <Text
              style={[styles.chipText, { color: active ? t.colors.onAccent : t.colors.text }]}
            >
              {project}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flexGrow: 0 },
  content: { gap: 6, paddingHorizontal: 16, paddingVertical: 2 },
  chip: {
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  chipText: { fontSize: 13, lineHeight: 18 },
});
