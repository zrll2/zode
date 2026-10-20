import React from "react";
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useTheme } from "../theme";
import { formatBytes } from "../attachments";
import { Text } from "./Text";

export interface TrayAttachment {
  key: string;
  fileName: string;
  mime: string;
  isImage: boolean;
  sizeBytes: number;
  localUri?: string;
  dataBase64?: string;
  ref?: string;
  bytes?: number;
  state: "uploading" | "ready" | "failed";
}

interface AttachmentTrayProps {
  items: TrayAttachment[];
  onRemove: (key: string) => void;
  onRetry: (key: string) => void;
}

// 64 px chips for pending attachments: image thumbnails or file chips, each
// with upload state and a remove button. Failed chips retry on tap.
export function AttachmentTray({ items, onRemove, onRetry }: AttachmentTrayProps) {
  const t = useTheme();
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.row}
      style={styles.scroll}
      accessible={false}
    >
      {items.map((item) => (
        <View
          key={item.key}
          style={[
            styles.chip,
            { backgroundColor: t.colors.muted },
            item.state === "failed" ? { borderColor: t.colors.danger, borderWidth: 1 } : undefined,
          ]}
        >
          {item.isImage && item.localUri ? (
            <Image source={{ uri: item.localUri }} style={styles.thumb} />
          ) : (
            <View style={styles.fileBody}>
              <Feather name="file-text" size={16} color={t.colors.subtext} />
              <Text numberOfLines={1} style={[styles.fileName, { color: t.colors.subtext }]}>
                {item.fileName}
              </Text>
            </View>
          )}
          {item.state === "uploading" ? (
            <ActivityIndicator size="small" color={t.colors.subtext} style={styles.state} />
          ) : item.state === "failed" ? (
            <Pressable
              onPress={() => onRetry(item.key)}
              accessibilityRole="button"
              accessibilityLabel={`Retry ${item.fileName}`}
              hitSlop={6}
            >
              <Feather name="rotate-ccw" size={14} color={t.colors.danger} />
            </Pressable>
          ) : (
            <Text numberOfLines={1} style={[styles.size, { color: t.colors.subtext }]}>
              {formatBytes(item.sizeBytes)}
            </Text>
          )}
          <Pressable
            onPress={() => onRemove(item.key)}
            accessibilityRole="button"
            accessibilityLabel={`Remove ${item.fileName}`}
            hitSlop={6}
            style={[styles.remove, { backgroundColor: t.colors.surface }]}
          >
            <Feather name="x" size={11} color={t.colors.text} />
          </Pressable>
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flexGrow: 0 },
  row: { gap: 8, paddingHorizontal: 20, paddingBottom: 6 },
  chip: {
    width: 64,
    height: 64,
    borderRadius: 12,
    padding: 6,
    alignItems: "center",
    justifyContent: "center",
    gap: 2,
  },
  thumb: { width: 52, height: 52, borderRadius: 8 },
  fileBody: { alignItems: "center", gap: 2, width: 52 },
  fileName: { fontSize: 8.5, lineHeight: 10 },
  state: { height: 16 },
  size: { fontSize: 8.5, lineHeight: 10 },
  remove: {
    position: "absolute",
    top: -5,
    right: -5,
    width: 18,
    height: 18,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
  },
});
