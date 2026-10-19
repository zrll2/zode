import React, { useEffect, useState } from "react";
import { Modal, StyleSheet, View } from "react-native";
import * as Haptics from "expo-haptics";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { radius, useTheme } from "../theme";
import { Pill } from "./Pill";
import { Text } from "./Text";

export type ApprovalDecision = "allow" | "deny";

export interface ApprovalActionsState {
  showButtons: boolean;
  feedback: string | null;
}

// Pure state for the sheet: buttons until the request is answered, then a
// short feedback line (a local decision, or answered on the Mac).
export function approvalActionsState(
  answeredElsewhere: boolean,
  decided: ApprovalDecision | null,
): ApprovalActionsState {
  if (answeredElsewhere) return { showButtons: false, feedback: "Answered on your Mac" };
  if (decided) {
    return {
      showButtons: false,
      feedback: decided === "allow" ? "Allowed" : "Denied",
    };
  }
  return { showButtons: true, feedback: null };
}

interface ApprovalSheetProps {
  visible: boolean;
  title: string;
  folder: string;
  toolName: string;
  target: string;
  reason: string;
  onAllow: () => void;
  onDeny: () => void;
  answeredElsewhere: boolean;
}

// Bottom sheet for permission requests (DESIGN.md §3.5). Presentational
// only: the caller turns `visible` off. Light haptic on both buttons.
export function ApprovalSheet({
  visible,
  title,
  folder,
  toolName,
  target,
  reason,
  onAllow,
  onDeny,
  answeredElsewhere,
}: ApprovalSheetProps) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const [decided, setDecided] = useState<ApprovalDecision | null>(null);

  useEffect(() => {
    if (visible) setDecided(null);
  }, [visible]);

  const actions = approvalActionsState(answeredElsewhere, decided);

  function decide(decision: ApprovalDecision) {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setDecided(decision);
    if (decision === "allow") onAllow();
    else onDeny();
  }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={() => {}}>
      <View style={[styles.backdrop, { backgroundColor: t.colors.scrim }]}>
        <View
          style={[
            styles.sheet,
            { backgroundColor: t.colors.surface, paddingBottom: insets.bottom + 24 },
          ]}
        >
          <View style={[styles.handle, { backgroundColor: t.colors.border }]} />
          <Text variant="display" style={{ fontSize: 22, lineHeight: 28 }}>
            {title}
          </Text>
          <Text variant="rowSubtitle" color="subtext">
            {folder}
          </Text>
          <View style={[styles.detail, { backgroundColor: t.colors.muted }]}>
            <Text variant="rowTitle" numberOfLines={1}>
              {toolName}
            </Text>
            <Text variant="mono" numberOfLines={1} selectable>
              {target}
            </Text>
            {reason ? (
              <Text variant="bodySmall" color="subtext">
                {reason}
              </Text>
            ) : undefined}
          </View>
          {actions.feedback ? (
            <Text variant="bodySmall" color="subtext" style={styles.feedback}>
              {actions.feedback}
            </Text>
          ) : actions.showButtons ? (
            <View style={styles.buttons}>
              <Pill
                label="Deny"
                variant="quiet"
                onPress={() => decide("deny")}
                style={styles.button}
                accessibilityLabel="Deny this request"
              />
              <Pill
                label="Allow"
                onPress={() => decide("allow")}
                style={styles.button}
                accessibilityLabel="Allow this request"
              />
            </View>
          ) : undefined}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: "flex-end" },
  sheet: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingTop: 8,
    paddingHorizontal: 24,
    gap: 8,
  },
  handle: { width: 36, height: 4, borderRadius: 2, alignSelf: "center", marginBottom: 12 },
  detail: { borderRadius: radius.code, padding: 12, gap: 4, marginTop: 4 },
  buttons: { flexDirection: "row", gap: 12, marginTop: 8 },
  button: { flex: 1, alignSelf: "stretch" },
  feedback: { marginTop: 8 },
});
