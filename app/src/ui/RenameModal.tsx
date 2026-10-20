import React, { useEffect, useState } from "react";
import { Modal, Pressable, StyleSheet, TextInput, View } from "react-native";
import { useTheme } from "../theme";
import { Pill } from "./Pill";
import { Text } from "./Text";

interface RenameModalProps {
  visible: boolean;
  title: string;
  onClose: () => void;
  onSave: (nextTitle: string) => void;
}

// Centred rename dialog: autofocus with the current title selected, 120-char
// cap, Save disabled while empty or unchanged.
export function RenameModal({ visible, title, onClose, onSave }: RenameModalProps) {
  const t = useTheme();
  const [draft, setDraft] = useState(title);

  useEffect(() => {
    if (visible) setDraft(title);
  }, [visible, title]);

  const trimmed = draft.trim();
  const canSave = trimmed.length > 0 && trimmed !== title.trim();

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={[styles.backdrop, { backgroundColor: t.colors.scrim }]} onPress={onClose}>
        <Pressable style={[styles.card, { backgroundColor: t.colors.surface }]} onPress={() => {}}>
          <Text variant="display" style={{ fontSize: 20, lineHeight: 26 }}>
            Rename
          </Text>
          <TextInput
            style={[
              styles.input,
              {
                backgroundColor: t.colors.bg,
                borderColor: t.colors.border,
                color: t.colors.text,
              },
            ]}
            value={draft}
            onChangeText={setDraft}
            autoFocus
            selectTextOnFocus
            maxLength={120}
            returnKeyType="done"
            onSubmitEditing={() => {
              if (canSave) onSave(trimmed);
            }}
            placeholder="Conversation name"
            placeholderTextColor={t.colors.subtext}
            accessibilityLabel="Conversation name"
          />
          <View style={styles.buttons}>
            <Pill label="Cancel" variant="quiet" onPress={onClose} style={styles.flex} />
            <Pill
              label="Save"
              onPress={() => onSave(trimmed)}
              disabled={!canSave}
              style={styles.flex}
            />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  card: {
    alignSelf: "stretch",
    borderRadius: 24,
    padding: 20,
    gap: 12,
  },
  input: {
    minHeight: 44,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    paddingHorizontal: 12,
    fontSize: 15,
  },
  buttons: { flexDirection: "row", gap: 12 },
  flex: { flex: 1 },
});
