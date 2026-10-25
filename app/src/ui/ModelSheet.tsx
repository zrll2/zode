import React from "react";
import { StyleSheet, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useTheme } from "../theme";
import { thinkingLabel, type ModelOption } from "../chatSettings";
import { PressScale } from "./PressScale";
import { Sheet } from "./Sheet";
import { Text } from "./Text";

interface ModelSheetProps {
  visible: boolean;
  onClose: () => void;
  running: boolean;
  models: ModelOption[];
  currentModelId: string | null;
  currentLevel: string | null;
  thoughtLevels: string[];
  onPickModel: (option: ModelOption, reasoningLevel?: string) => void;
  onPickLevel: (level: string) => void;
}

// "Model and thinking" sheet. Picking a model keeps the current reasoning
// level when the new model supports it, else the model's own default.
export function ModelSheet({
  visible,
  onClose,
  running,
  models,
  currentModelId,
  currentLevel,
  thoughtLevels,
  onPickModel,
  onPickLevel,
}: ModelSheetProps) {
  const t = useTheme();

  function pickModel(option: ModelOption) {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const supported =
      currentLevel !== null && option.reasoningLevels.includes(currentLevel)
        ? currentLevel
        : (option.defaultLevel ?? option.reasoningLevels[0]);
    onPickModel(option, supported ?? undefined);
  }

  function pickLevel(level: string) {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onPickLevel(level);
  }

  return (
    <Sheet visible={visible} onClose={onClose}>
      <Text variant="display" style={{ fontSize: 22, lineHeight: 28 }}>
        Model
      </Text>
      {running ? (
        <Text variant="caption" color="warn">
          Stop to change
        </Text>
      ) : undefined}
      <View style={styles.group}>
        {models.length === 0 ? (
          <Text variant="bodySmall" color="subtext">
            No models available.
          </Text>
        ) : (
          models.map((option) => {
            const current = option.modelId === currentModelId;
            return (
              <PressScale
                key={option.modelId}
                disabled={running}
                onPress={() => pickModel(option)}
                accessibilityRole="button"
                accessibilityLabel={`${option.label}, ${option.providerLabel}${
                  current ? ", current" : ""
                }`}
                style={[styles.modelRow, { backgroundColor: t.colors.muted }]}
              >
                <View style={styles.flex}>
                  <Text numberOfLines={1} style={styles.rowTitle}>
                    {option.label}
                  </Text>
                  {option.providerLabel ? (
                    <Text variant="caption" color="subtext" numberOfLines={1}>
                      {option.providerLabel}
                    </Text>
                  ) : undefined}
                </View>
                {current ? (
                  <Feather name="check" size={18} color={t.colors.accent} />
                ) : undefined}
              </PressScale>
            );
          })
        )}
      </View>
      <Text variant="sectionHeader" color="subtext" style={styles.section}>
        Thinking
      </Text>
      <View style={styles.levels}>
        {thoughtLevels.map((level) => {
          const current = level === currentLevel;
          return (
            <PressScale
              key={level}
              disabled={running}
              onPress={() => pickLevel(level)}
              accessibilityRole="button"
              accessibilityLabel={`Thinking level ${thinkingLabel(level)}${current ? ", current" : ""}`}
              style={[
                styles.level,
                { backgroundColor: current ? t.colors.accent : t.colors.muted },
              ]}
            >
              <Text
                style={{
                  color: current ? t.colors.onAccent : t.colors.text,
                  fontWeight: "600",
                  fontSize: 14,
                }}
              >
                {thinkingLabel(level)}
              </Text>
            </PressScale>
          );
        })}
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  group: { gap: 8, marginTop: 8 },
  modelRow: {
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderRadius: 18,
    paddingHorizontal: 16,
    paddingVertical: 11,
  },
  flex: { flex: 1 },
  rowTitle: { fontSize: 15, lineHeight: 20, fontWeight: "600" },
  section: { marginTop: 20 },
  levels: { flexDirection: "row", gap: 8 },
  level: {
    flex: 1,
    minHeight: 44,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
  },
});
