import React, { useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { Stack, useRouter } from "expo-router";
import { Feather } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRelay } from "../src/useRelay";
import { useTheme } from "../src/theme";
import { SESSION_MODES, type SessionMode } from "../src/config";
import { buildSessionCreateParams, buildSessionSubscribeParams } from "../src/relay/params";
import { basename } from "../src/util";
import { Pill } from "../src/ui/Pill";
import { Row } from "../src/ui/Row";
import { Screen } from "../src/ui/Screen";
import { SectionHeader } from "../src/ui/SectionHeader";
import { Text } from "../src/ui/Text";

const MODE_LABELS: Record<SessionMode, string> = {
  plan: "Read only",
  edit: "Edit files",
};

export default function NewSessionScreen() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { servers, rpc } = useRelay();
  const [serverIdx, setServerIdx] = useState(0);
  const [mode, setMode] = useState<SessionMode>("edit");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    if (busy) return;
    const server = servers[serverIdx];
    setBusy(true);
    setError(null);
    try {
      const result: any = await rpc(
        "session/create",
        buildSessionCreateParams({
          workspacePath: server?.cwd ?? "",
          // ready.servers only carries cwd; the folder name stands in for workspaceKey.
          workspaceKey: server ? basename(server.cwd) : "",
          mode,
        }),
        server?.pid,
      );
      const sessionId = result?.session?.sessionId ?? result?.sessionId;
      if (typeof sessionId !== "string" || !sessionId) {
        throw new Error("session/create returned no session id.");
      }
      await rpc("session/subscribe", buildSessionSubscribeParams(sessionId), server?.pid);
      router.replace({ pathname: "/session/[id]", params: { id: sessionId, focus: "1" } });
    } catch (e: any) {
      setError(e?.message ?? "Could not create the session.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen padded={false} style={styles.flex}>
      <Stack.Screen options={{ headerTitle: "" }} />
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.flex}
      >
        <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 16 }}>
          <Text variant="display" style={{ marginTop: 8, marginBottom: 4 }}>
            New session
          </Text>
          <SectionHeader>Folder</SectionHeader>
          {servers.length === 0 ? (
            <Text variant="rowSubtitle" color="subtext">
              No ZCode servers are running on the Mac. Start Zode.app on your Mac, then try again.
            </Text>
          ) : (
            servers.map((server, index) => (
              <Row
                key={server.pid}
                title={basename(server.cwd)}
                subtitle={server.cwd}
                onPress={() => setServerIdx(index)}
                accessibilityLabel={`Use workspace ${basename(server.cwd)}`}
                right={
                  index === serverIdx ? (
                    <Feather name="check" size={20} color={t.colors.accent} />
                  ) : undefined
                }
              />
            ))
          )}
          <SectionHeader>Mode</SectionHeader>
          {SESSION_MODES.map((option) => (
            <Row
              key={option}
              title={MODE_LABELS[option]}
              onPress={() => setMode(option)}
              accessibilityLabel={`Mode ${MODE_LABELS[option]}`}
              right={
                mode === option ? (
                  <Feather name="check" size={20} color={t.colors.accent} />
                ) : undefined
              }
            />
          ))}
          {error ? (
            <Text variant="bodySmall" color="danger" numberOfLines={3} style={{ marginTop: 12 }}>
              {error}
            </Text>
          ) : undefined}
        </ScrollView>
        <View style={{ paddingHorizontal: 20, paddingBottom: insets.bottom + 16 }}>
          <Pill
            label={busy ? "Starting…" : "Start"}
            disabled={busy || servers.length === 0}
            onPress={() => void create()}
            style={styles.fullWidth}
          />
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  fullWidth: { alignSelf: "stretch" },
});
