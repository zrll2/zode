import React, { useEffect, useRef } from "react";
import { Pressable, StyleSheet, TextInput, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { radius, useTheme } from "../theme";
import type { ComposerVoice } from "../voice";
import { Dot } from "./Dot";
import { PressScale } from "./PressScale";
import { Text } from "./Text";
import { ThinkingDots } from "./ThinkingDots";

interface ComposerProps {
  value: string;
  onChangeText: (text: string) => void;
  onSend: () => void;
  onStop: () => void;
  running: boolean;
  // chat computes it: text or ready attachments present, not mid-send
  canSend: boolean;
  sendDisabled?: boolean;
  autoFocus?: boolean;
  placeholder?: string;
  onAddPress?: () => void;
  modeLabel?: string | null;
  onPermissionPress?: () => void;
  // Context-usage chip (P5): "42%" or the neutral "Usage" fallback.
  usageLabel?: string | null;
  usageTone?: "normal" | "warn" | "danger";
  onUsagePress?: () => void;
  // Voice input (V3): mic in place of send while the field is empty.
  voice?: ComposerVoice;
}

function clock(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

// Sticky composer: "+" (attachments), permission pill, usage chip, then the
// field with a 36 px accent circle (mic while empty, send with text, stop
// while running). Voice recording replaces the field with a calm strip.
export function Composer({
  value,
  onChangeText,
  onSend,
  onStop,
  running,
  canSend,
  sendDisabled = false,
  autoFocus,
  placeholder = "Message ZCode",
  onAddPress,
  modeLabel,
  onPermissionPress,
  usageLabel,
  usageTone = "normal",
  onUsagePress,
  voice,
}: ComposerProps) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const sendActive = running || (canSend && !sendDisabled);
  const usagePercent = parseUsagePercent(usageLabel);
  const toneColor =
    usageTone === "danger"
      ? t.colors.danger
      : usageTone === "warn"
        ? t.colors.warn
        : t.colors.subtext;

  const voiceActive = voice?.state === "recording" || voice?.state === "transcribing";
  const showMic =
    Boolean(voice?.available) &&
    !running &&
    !voiceActive &&
    value.trim().length === 0 &&
    !canSend;

  // The keyboard comes back after a transcription so the user can review.
  const inputRef = useRef<React.ComponentRef<typeof TextInput>>(null);
  const prevVoiceState = useRef<string | undefined>(undefined);
  useEffect(() => {
    const previous = prevVoiceState.current;
    prevVoiceState.current = voice?.state;
    if (previous === "transcribing" && voice?.state === "idle") inputRef.current?.focus();
  }, [voice?.state]);

  const tone = { backgroundColor: t.colors.surface, borderColor: t.colors.border };

  return (
    <View
      style={[
        styles.wrap,
        { backgroundColor: t.colors.bg, borderTopColor: t.colors.border, paddingBottom: insets.bottom + 8 },
      ]}
    >
      <View style={styles.controls}>
        {onAddPress ? (
          <PressScale
            onPress={onAddPress}
            accessibilityRole="button"
            accessibilityLabel="Add attachment"
            style={[styles.roundButton, { backgroundColor: t.colors.muted }]}
          >
            <Feather name="plus" size={18} color={t.colors.text} />
          </PressScale>
        ) : undefined}
        {modeLabel && onPermissionPress ? (
          <PressScale
            onPress={onPermissionPress}
            accessibilityRole="button"
            accessibilityLabel={`Permission: ${modeLabel}`}
            style={[styles.modePill, { backgroundColor: t.colors.muted }]}
          >
            <Text
              numberOfLines={1}
              style={{
                color: modeLabel === "Full access" ? t.colors.warn : t.colors.subtext,
                fontWeight: "600",
                fontSize: 12,
              }}
            >
              {modeLabel}
            </Text>
          </PressScale>
        ) : undefined}
        {usageLabel && onUsagePress ? (
          <PressScale
            onPress={onUsagePress}
            accessibilityRole="button"
            accessibilityLabel={
              usageLabel.endsWith("%")
                ? `Context ${usageLabel.slice(0, -1)} percent used. Opens usage.`
                : "Open usage"
            }
            hitSlop={8}
            style={[styles.modePill, { backgroundColor: t.colors.muted }]}
          >
            <View style={styles.usageRow}>
              <View style={[styles.usageRing, { borderColor: toneColor }]}>
                <View
                  style={[
                    styles.usageRingFill,
                    {
                      backgroundColor: toneColor,
                      height: Math.max(2, Math.round((11 * usagePercent) / 100)),
                    },
                  ]}
                />
              </View>
              <Text
                numberOfLines={1}
                style={{ color: toneColor, fontWeight: "600", fontSize: 12 }}
              >
                {usageLabel}
              </Text>
            </View>
          </PressScale>
        ) : undefined}
      </View>

      {voiceActive ? (
        <View style={[styles.field, tone]}>
          {voice?.state === "recording" ? (
            <>
              <Pressable
                onPress={voice.onCancel}
                accessibilityRole="button"
                accessibilityLabel="Cancel voice input"
                hitSlop={8}
                style={styles.voiceCancel}
              >
                <Text style={{ color: t.colors.subtext, fontSize: 13, fontWeight: "600" }}>
                  Cancel
                </Text>
              </Pressable>
              <View style={styles.listeningRow}>
                <Dot color={t.colors.accent} size={8} pulse />
                <Text style={[styles.listeningText, { color: t.colors.subtext }]}>
                  {`Listening... ${clock(voice.seconds)}`}
                </Text>
              </View>
            </>
          ) : (
            <View style={styles.listeningRow}>
              <Text style={[styles.listeningText, { color: t.colors.subtext }]}>
                Writing it down...
              </Text>
              <ThinkingDots />
            </View>
          )}
          <PressScale
            onPress={voice?.onStop}
            disabled={voice?.state !== "recording"}
            accessibilityRole="button"
            accessibilityLabel="Finish voice input"
            style={[
              styles.action,
              { backgroundColor: t.colors.accent, opacity: voice?.state === "recording" ? 1 : 0.4 },
            ]}
          >
            <Feather name="check" size={18} color={t.colors.onAccent} />
          </PressScale>
        </View>
      ) : (
        <View style={[styles.field, tone]}>
          <TextInput
            ref={inputRef}
            style={[styles.input, { color: t.colors.text }]}
            value={value}
            onChangeText={onChangeText}
            placeholder={placeholder}
            placeholderTextColor={t.colors.subtext}
            multiline
            autoFocus={autoFocus}
          />
          <PressScale
            onPress={() => {
              if (showMic) {
                void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                voice?.onStart();
                return;
              }
              if (running) {
                onStop();
                return;
              }
              if (!canSend || sendDisabled) return;
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              onSend();
            }}
            disabled={!running && !showMic && (!canSend || sendDisabled)}
            accessibilityRole="button"
            accessibilityLabel={
              running ? "Stop" : showMic ? "Speak instead of typing" : "Send message"
            }
            style={[
              styles.action,
              {
                backgroundColor: t.colors.accent,
                opacity: !running && !showMic && (!canSend || sendDisabled) ? 0.4 : 1,
              },
            ]}
          >
            <Feather
              name={running ? "square" : showMic ? "mic" : "arrow-up"}
              size={18}
              color={t.colors.onAccent}
            />
          </PressScale>
        </View>
      )}

      {voice?.error ? (
        <Text variant="caption" color="danger" numberOfLines={1} style={styles.voiceError}>
          {voice.error}
        </Text>
      ) : undefined}
    </View>
  );
}

// "42%" → 42; the neutral "Usage" label → 0 (empty gauge).
function parseUsagePercent(label: string | null | undefined): number {
  if (!label || !label.endsWith("%")) return 0;
  const parsed = Number.parseInt(label, 10);
  return Number.isFinite(parsed) ? Math.min(100, Math.max(0, parsed)) : 0;
}

const styles = StyleSheet.create({
  wrap: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 8,
    paddingHorizontal: 20,
  },
  controls: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 6,
    minHeight: 28,
  },
  roundButton: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  modePill: {
    minHeight: 28,
    borderRadius: 999,
    paddingHorizontal: 10,
    alignItems: "center",
    justifyContent: "center",
    maxWidth: 110,
  },
  usageRow: { flexDirection: "row", alignItems: "center", gap: 5 },
  // 14 px circle outline; the inner bar rises with the used percent.
  usageRing: {
    width: 14,
    height: 14,
    borderRadius: 7,
    borderWidth: 1.5,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "flex-end",
  },
  usageRingFill: { width: 11, borderRadius: 1 },
  field: {
    flexDirection: "row",
    alignItems: "flex-end",
    borderRadius: radius.composer,
    borderWidth: StyleSheet.hairlineWidth,
    paddingLeft: 16,
    paddingRight: 8,
    paddingTop: 6,
    paddingBottom: 6,
    gap: 8,
  },
  input: {
    flex: 1,
    fontSize: 16,
    lineHeight: 22,
    maxHeight: 150,
    paddingTop: 6,
    paddingBottom: 6,
  },
  action: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 2,
  },
  voiceCancel: { paddingVertical: 12, paddingRight: 4, alignSelf: "center" },
  listeningRow: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 12,
  },
  listeningText: { fontSize: 15, lineHeight: 20, fontVariant: ["tabular-nums"] },
  voiceError: { marginTop: 4 },
});
