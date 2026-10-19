import React, { useCallback, useMemo, useState } from "react";
import {
  ActionSheetIOS,
  Alert,
  Platform,
  Pressable,
  RefreshControl,
  SectionList,
  StyleSheet,
  View,
} from "react-native";
import { Stack, useFocusEffect, useRouter } from "expo-router";
import { Feather } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRelay } from "../src/useRelay";
import { useTheme } from "../src/theme";
import { parseSessionList, timeAgo, type SessionRow } from "../src/util";
import type { RelayStatus } from "../src/relay/client";
import { groupSessions } from "../src/sessionGroups";
import { Dot } from "../src/ui/Dot";
import { Pill } from "../src/ui/Pill";
import { Row } from "../src/ui/Row";
import { Screen } from "../src/ui/Screen";
import { SectionHeader } from "../src/ui/SectionHeader";
import { Text } from "../src/ui/Text";

export default function SessionsScreen() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { status, authFailed, rpc, unpair, demo, exitDemo } = useRelay();
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showStatusLine, setShowStatusLine] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      const result = await rpc("session/list", {});
      setSessions(parseSessionList(result));
    } catch (e: any) {
      setError(e?.message ?? "Failed to load sessions.");
    } finally {
      setRefreshing(false);
    }
  }, [rpc]);

  useFocusEffect(
    useCallback(() => {
      if (status === "ready") void load();
    }, [status, load]),
  );

  const confirmUnpair = useCallback(() => {
    Alert.alert("Unpair this phone?", "You will need to scan a new QR code to reconnect.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Unpair",
        style: "destructive",
        onPress: () => {
          void (async () => {
            await unpair();
            router.replace("/pair");
          })();
        },
      },
    ]);
  }, [unpair, router]);

  const confirmExitDemo = useCallback(() => {
    Alert.alert(
      "Exit demo?",
      "The sample sessions disappear. Pair with your Mac to use ZCode for real.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Exit demo",
          style: "destructive",
          onPress: () => {
            void (async () => {
              await exitDemo();
              router.replace("/pair");
            })();
          },
        },
      ],
    );
  }, [exitDemo, router]);

  const showMenu = useCallback(() => {
    const destructiveLabel = demo ? "Exit demo" : "Unpair this phone";
    const onDestructive = demo ? confirmExitDemo : confirmUnpair;
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: [destructiveLabel, "Cancel"],
          destructiveButtonIndex: 0,
          cancelButtonIndex: 1,
        },
        (index) => {
          if (index === 0) onDestructive();
        },
      );
    } else {
      Alert.alert("Options", undefined, [
        { text: destructiveLabel, style: "destructive", onPress: onDestructive },
        { text: "Cancel", style: "cancel" },
      ]);
    }
  }, [demo, confirmUnpair, confirmExitDemo]);

  // SectionList wants `data`; groupSessions speaks in `items`.
  const sections = useMemo(
    () =>
      groupSessions(sessions, Date.now()).map((section) => ({
        key: section.key,
        title: section.title,
        data: section.items,
      })),
    [sessions],
  );

  const statusText: Record<RelayStatus, string> = {
    connecting: "Connecting…",
    ready: "Connected",
    reconnecting: "Reconnecting…",
    closed: authFailed
      ? "Pairing rejected — unpair and pair again"
      : "Offline: check that the relay is running",
  };
  const statusLabel: Record<RelayStatus, string> = {
    connecting: "Connecting",
    ready: "Connected",
    reconnecting: "Reconnecting",
    closed: authFailed ? "Pairing rejected" : "Offline",
  };
  const dotColor =
    status === "ready" ? t.colors.ok : status === "closed" ? t.colors.subtext : t.colors.warn;
  const showLine = status !== "ready" || showStatusLine;

  return (
    <Screen padded={false} style={styles.screen}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={[styles.header, { paddingHorizontal: 20 }]}>
        <Text variant="display" style={styles.flex}>
          Zode
        </Text>
        <Pressable
          onPress={() => setShowStatusLine((value) => !value)}
          accessibilityRole="button"
          accessibilityLabel={`Connection status: ${statusLabel[status]}`}
          hitSlop={8}
          style={styles.dotWrap}
        >
          <Dot color={dotColor} size={10} pulse={status === "reconnecting"} />
        </Pressable>
        <Pressable
          onPress={showMenu}
          accessibilityRole="button"
          accessibilityLabel="More options"
          hitSlop={8}
        >
          <Feather name="more-horizontal" size={22} color={t.colors.text} />
        </Pressable>
      </View>
      {showLine ? (
        <Text variant="caption" color="subtext" style={styles.line}>
          {statusText[status]}
        </Text>
      ) : undefined}
      {error ? (
        <Text variant="caption" color="danger" numberOfLines={2} style={styles.line}>
          {error}
        </Text>
      ) : undefined}
      <SectionList
        sections={sections}
        keyExtractor={(row) => row.id}
        renderItem={({ item }) => <SessionRowItem item={item} />}
        renderSectionHeader={({ section }) => <SectionHeader>{section.title}</SectionHeader>}
        ItemSeparatorComponent={Divider}
        stickySectionHeadersEnabled={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void load()}
            tintColor={t.colors.subtext}
          />
        }
        ListEmptyComponent={
          !refreshing && status === "ready" && !error ? (
            <View style={styles.empty}>
              <Text variant="display" style={{ fontSize: 22, lineHeight: 28 }}>
                No sessions yet
              </Text>
              <Text variant="rowSubtitle" color="subtext" style={styles.emptyLine}>
                Sessions running on your Mac will appear here.
              </Text>
              <Pill
                label="New session"
                onPress={() => router.push("/new")}
                style={{ marginTop: 16 }}
              />
            </View>
          ) : undefined
        }
        contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: insets.bottom + 120 }}
      />
      <Pressable
        onPress={() => router.push("/new")}
        accessibilityRole="button"
        accessibilityLabel="New session"
        style={[styles.fab, { backgroundColor: t.colors.accent, bottom: insets.bottom + 20 }]}
      >
        <Feather name="edit-3" size={22} color={t.colors.onAccent} />
      </Pressable>
    </Screen>
  );
}

function SessionRowItem({ item }: { item: SessionRow }) {
  const t = useTheme();
  const router = useRouter();
  const waiting = item.status === "waiting";
  const failed = item.status === "error";
  const running = item.status === "running";
  const statusWord = running
    ? "running"
    : waiting
      ? "waiting for approval"
      : failed
        ? "error"
        : item.status !== "idle"
          ? item.status
          : "";
  const subtitle = [item.folder || "No workspace", statusWord, timeAgo(item.updatedAt)]
    .filter(Boolean)
    .join(" · ");
  const dotColor = waiting
    ? t.colors.warn
    : failed
      ? t.colors.danger
      : running
        ? t.colors.accent
        : undefined;
  return (
    <Row
      title={item.title}
      subtitle={subtitle}
      onPress={() =>
        router.push({ pathname: "/session/[id]", params: { id: item.id, title: item.title } })
      }
      accessibilityLabel={`Open session ${item.title}${running ? ", running" : ""}${
        waiting ? ", waiting for approval" : ""
      }`}
      right={dotColor ? <Dot color={dotColor} pulse={running} /> : undefined}
    />
  );
}

function Divider() {
  const t = useTheme();
  return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: t.colors.border }} />;
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
    paddingTop: 12,
    paddingBottom: 8,
  },
  flex: { flex: 1 },
  dotWrap: { paddingHorizontal: 4 },
  line: { paddingHorizontal: 20, marginBottom: 4 },
  empty: { alignItems: "center", marginTop: 96, paddingHorizontal: 20 },
  emptyLine: { textAlign: "center", marginTop: 8 },
  fab: {
    position: "absolute",
    right: 20,
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: "center",
    justifyContent: "center",
  },
});
