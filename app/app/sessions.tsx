import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActionSheetIOS,
  Alert,
  Image,
  Platform,
  Pressable,
  RefreshControl,
  SectionList,
  StyleSheet,
  View,
} from "react-native";
import { Stack, useFocusEffect, useRouter } from "expo-router";
import { Feather } from "@expo/vector-icons";
import Constants from "expo-constants";
import * as Haptics from "expo-haptics";
import * as Linking from "expo-linking";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRelay } from "../src/useRelay";
import { useTheme } from "../src/theme";
import { retryInSeconds } from "../src/relay/backoff";
import { buildUsageStatsParams } from "../src/relay/params";
import { PRIVACY_URL, SUPPORT_URL } from "../src/config";
import { buildHomeSections } from "../src/sessionGroups";
import { projectName, statusInfo } from "../src/sessionStatus";
import {
  addArchived,
  deleteSession,
  isArchived,
  removeArchived,
} from "../src/sessionActions";
import { loadPrefs, savePrefs, type Prefs } from "../src/storage";
import { parseSessionList, timeAgo, type SessionRow } from "../src/util";
import type { RelayStatus } from "../src/relay/client";
import { Dot } from "../src/ui/Dot";
import { Pill } from "../src/ui/Pill";
import { PressScale } from "../src/ui/PressScale";
import { Screen } from "../src/ui/Screen";
import { SessionCard } from "../src/ui/SessionCard";
import { Text } from "../src/ui/Text";
import { UsageSheet } from "../src/ui/UsageSheet";
import { buildMenuItems } from "../src/ui/menu";

// App version comes from app.json (expo.version) for the sheet title.
const APP_VERSION = Constants.expoConfig?.version;
// Loaded in app/_layout.tsx; falls back to the system font until it is.
const WORDMARK_FONT = "Nunito_800ExtraBold";

function ReconnectingLine({
  retryAt,
  showRetry,
  onRetry,
}: {
  retryAt: number | null;
  showRetry: boolean;
  onRetry: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <View style={styles.reconnectRow}>
      <Text variant="caption" color="warn" style={styles.flex}>
        {retryAt
          ? `Reconnecting, next try in ${retryInSeconds(retryAt, now)} s`
          : "Reconnecting…"}
      </Text>
      {showRetry ? (
        <Pressable
          onPress={onRetry}
          accessibilityRole="button"
          accessibilityLabel="Retry now"
          hitSlop={8}
        >
          <Text variant="caption" color="warn" style={{ fontWeight: "600" }}>
            Retry now
          </Text>
        </Pressable>
      ) : undefined}
    </View>
  );
}

export default function SessionsScreen() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const {
    status,
    authFailed,
    client,
    rpc,
    unpair,
    demo,
    exitDemo,
    retryAt,
    reconnectAttempts,
    retryNow,
  } = useRelay();
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showStatusLine, setShowStatusLine] = useState(false);
  const [usageVisible, setUsageVisible] = useState(false);
  const [prefs, setPrefs] = useState<Prefs>({
    showWorkOrders: false,
    archivedIds: [],
    showArchived: false,
  });

  useEffect(() => {
    void (async () => {
      setPrefs(await loadPrefs());
    })();
  }, []);

  const updatePrefs = useCallback((patch: Partial<Prefs>) => {
    setPrefs((current) => {
      const next = { ...current, ...patch };
      void savePrefs(next);
      return next;
    });
  }, []);

  const toggleWorkOrders = useCallback(() => {
    updatePrefs({ showWorkOrders: !prefs.showWorkOrders });
  }, [prefs.showWorkOrders, updatePrefs]);

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
    const items: { key: string; label: string; destructive?: boolean }[] = [
      {
        key: "work-orders",
        label: prefs.showWorkOrders ? "Hide work orders" : "Show work orders",
      },
      {
        key: "archived",
        label: prefs.showArchived ? "Hide archived" : "Show archived",
      },
      { key: "usage", label: "Usage" },
      ...buildMenuItems({ demo }),
    ];
    const labels = items.map((item) => item.label);
    const destructiveIndex = items.findIndex((item) => item.destructive);
    const cancelIndex = items.findIndex((item) => item.key === "cancel");
    const title = APP_VERSION ? `Zode ${APP_VERSION}` : "Zode";
    const runItem = (item: { key: string } | undefined) => {
      if (!item) return;
      switch (item.key) {
        case "work-orders":
          toggleWorkOrders();
          break;
        case "archived":
          updatePrefs({ showArchived: !prefs.showArchived });
          break;
        case "usage":
          setUsageVisible(true);
          break;
        case "privacy":
          void Linking.openURL(PRIVACY_URL).catch(() => {});
          break;
        case "support":
          void Linking.openURL(SUPPORT_URL).catch(() => {});
          break;
        case "unpair":
          confirmUnpair();
          break;
        case "exit-demo":
          confirmExitDemo();
          break;
      }
    };
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          title,
          options: labels,
          cancelButtonIndex: cancelIndex,
          destructiveButtonIndex: destructiveIndex === -1 ? undefined : destructiveIndex,
        },
        (index) => runItem(items[index]),
      );
    } else {
      Alert.alert(
        title,
        undefined,
        items.map((item) => ({
          text: item.label,
          style:
            item.key === "cancel" ? "cancel" : item.destructive ? "destructive" : "default",
          onPress: () => runItem(item),
        })),
      );
    }
  }, [demo, prefs.showWorkOrders, prefs.showArchived, updatePrefs, toggleWorkOrders, confirmUnpair, confirmExitDemo]);

  const fetchAccountUsage = useCallback(
    (range: "7d" | "30d" | "all") => rpc("usage/stats", buildUsageStatsParams(range)),
    [rpc],
  );

  const { sections, hiddenWorkOrders, hiddenArchived } = useMemo(
    () => buildHomeSections(sessions, Date.now(), prefs),
    [sessions, prefs],
  );
  const listSections = useMemo(
    () =>
      sections.map((section) => ({
        key: section.key,
        title: section.title,
        data: section.items,
      })),
    [sections],
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

  // Archive is local to this phone; delete removes it on the Mac.
  const toggleArchive = useCallback(
    (session: SessionRow) => {
      updatePrefs({
        archivedIds: isArchived(prefs.archivedIds, session.id)
          ? removeArchived(prefs.archivedIds, session.id)
          : addArchived(prefs.archivedIds, session.id),
      });
    },
    [prefs.archivedIds, updatePrefs],
  );

  const requestDelete = useCallback(
    (session: SessionRow) => {
      if (session.status === "running") {
        Alert.alert("Stop it first", undefined, [{ text: "OK" }]);
        return;
      }
      if (!client) {
        Alert.alert("Could not delete", "Not connected.", [{ text: "OK" }]);
        return;
      }
      Alert.alert(
        "Delete this conversation?",
        "It is removed from ZCode on your Mac. This cannot be undone.",
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Delete",
            style: "destructive",
            onPress: () => {
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              void (async () => {
                try {
                  await deleteSession(client, session.id);
                  // Drop it from the list at once; also forget an archive.
                  setSessions((current) =>
                    current.filter((entry) => entry.id !== session.id),
                  );
                  setPrefs((current) => ({
                    ...current,
                    archivedIds: removeArchived(current.archivedIds, session.id),
                  }));
                } catch (e: any) {
                  Alert.alert("Could not delete", e?.message ?? "Delete failed.", [
                    { text: "OK" },
                  ]);
                }
              })();
            },
          },
        ],
      );
    },
    [client],
  );

  const showCardActions = useCallback(
    (session: SessionRow) => {
      const archived = isArchived(prefs.archivedIds, session.id);
      const items = [
        { key: "archive", label: archived ? "Unarchive" : "Archive" },
        { key: "delete", label: "Delete", destructive: true },
        { key: "cancel", label: "Cancel" },
      ];
      const runItem = (item: { key: string } | undefined) => {
        if (!item) return;
        if (item.key === "archive") toggleArchive(session);
        if (item.key === "delete") requestDelete(session);
      };
      if (Platform.OS === "ios") {
        ActionSheetIOS.showActionSheetWithOptions(
          {
            options: items.map((item) => item.label),
            destructiveButtonIndex: 1,
            cancelButtonIndex: 2,
          },
          (index) => runItem(items[index]),
        );
      } else {
        Alert.alert(
          session.title,
          undefined,
          items.map((item) => ({
            text: item.label,
            style: item.key === "cancel" ? ("cancel" as const) : item.destructive ? ("destructive" as const) : ("default" as const),
            onPress: () => runItem(item),
          })),
        );
      }
    },
    [prefs.archivedIds, toggleArchive, requestDelete],
  );

  const renderItem = useCallback(
    ({ item }: { item: SessionRow }) => {
      const info = statusInfo(item.status);
      const archived = isArchived(prefs.archivedIds, item.id);
      return (
        <SessionCard
          folder={item.folder}
          status={item.status}
          timeLabel={timeAgo(item.updatedAt)}
          showChevron={item.status === "waiting" || item.status === "error"}
          onPress={() =>
            router.push({
              pathname: "/session/[id]",
              params: { id: item.id, title: item.title },
            })
          }
          onLongPress={() => showCardActions(item)}
          accessibilityActions={[
            { name: "archive", label: archived ? "Unarchive" : "Archive" },
            { name: "delete", label: "Delete" },
          ]}
          onAccessibilityAction={(event) => {
            if (event.nativeEvent.actionName === "archive") toggleArchive(item);
            if (event.nativeEvent.actionName === "delete") requestDelete(item);
          }}
          accessibilityLabel={`${projectName(item.folder)}, ${info.word}, ${timeAgo(
            item.updatedAt,
          )}`}
        />
      );
    },
    [router, prefs.archivedIds, toggleArchive, requestDelete, showCardActions],
  );

  return (
    <Screen padded={false} style={styles.screen}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={[styles.header, { paddingHorizontal: 20 }]}>
        <Image
          source={require("../assets/zode-mark.png")}
          style={styles.mark}
          resizeMode="contain"
        />
        <Text style={[styles.wordmark, { color: t.colors.text }]}>Zode</Text>
        <PressScale
          onPress={() => setShowStatusLine((value) => !value)}
          accessibilityRole="button"
          accessibilityLabel={`Connection status: ${statusLabel[status]}`}
          hitSlop={8}
          style={styles.macPill}
        >
          <Dot color={dotColor} size={6} pulse={status === "reconnecting"} />
          <Text color="subtext" style={styles.macText}>
            Mac
          </Text>
        </PressScale>
        <PressScale
          onPress={showMenu}
          accessibilityRole="button"
          accessibilityLabel="More options"
          hitSlop={8}
          style={[styles.moreButton, { backgroundColor: t.colors.muted }]}
        >
          <Feather name="more-horizontal" size={18} color={t.colors.text} />
        </PressScale>
      </View>
      {status === "reconnecting" ? (
        <ReconnectingLine
          retryAt={retryAt}
          showRetry={reconnectAttempts >= 3}
          onRetry={retryNow}
        />
      ) : showLine ? (
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
        sections={listSections}
        keyExtractor={(row) => row.id}
        renderItem={renderItem}
        renderSectionHeader={({ section }) => (
          <View style={styles.sectionHeader}>
            <Text variant="sectionHeader" color="subtext">
              {section.title}
            </Text>
            <Text variant="sectionHeader" color="subtext">
              {section.data.length}
            </Text>
          </View>
        )}
        ItemSeparatorComponent={CardGap}
        stickySectionHeadersEnabled={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void load()}
            tintColor={t.colors.subtext}
          />
        }
        ListEmptyComponent={
          status !== "ready" ? (
            <View style={styles.skeletonWrap}>
              {[0, 1, 2].map((index) => (
                <View
                  key={index}
                  style={[styles.skeletonCard, { backgroundColor: t.colors.surface }]}
                >
                  <View style={[styles.skeletonBar, { backgroundColor: t.colors.muted }]} />
                </View>
              ))}
            </View>
          ) : !error ? (
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
        ListFooterComponent={
          <View>
            {hiddenWorkOrders > 0 && !prefs.showWorkOrders ? (
              <Pressable
                onPress={toggleWorkOrders}
                accessibilityRole="button"
                accessibilityLabel={`Show ${hiddenWorkOrders} hidden work orders`}
                hitSlop={8}
                style={styles.hiddenFooter}
              >
                <Text color="subtext" style={styles.hiddenText}>
                  {hiddenWorkOrders} work orders hidden · Show
                </Text>
              </Pressable>
            ) : undefined}
            {hiddenArchived > 0 && !prefs.showArchived ? (
              <Pressable
                onPress={() => updatePrefs({ showArchived: true })}
                accessibilityRole="button"
                accessibilityLabel={`Show ${hiddenArchived} archived conversations`}
                hitSlop={8}
                style={styles.hiddenFooter}
              >
                <Text color="subtext" style={styles.hiddenText}>
                  {hiddenArchived} archived · Show
                </Text>
              </Pressable>
            ) : undefined}
          </View>
        }
        contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: insets.bottom + 108 }}
      />
      <View style={[styles.barWrap, { bottom: insets.bottom + 12 }]}>
        <PressScale
          onPress={() => router.push("/new")}
          accessibilityRole="button"
          accessibilityLabel="Ask ZCode"
          style={[styles.bar, { backgroundColor: t.colors.surface, shadowColor: t.colors.text }]}
        >
          <Text color="subtext" style={styles.barText}>
            Ask ZCode…
          </Text>
          <View style={[styles.sendCircle, { backgroundColor: t.colors.accent }]}>
            <Feather name="arrow-up" size={18} color={t.colors.onAccent} />
          </View>
        </PressScale>
      </View>
      <UsageSheet
        visible={usageVisible}
        onClose={() => setUsageVisible(false)}
        fetchAccountUsage={fetchAccountUsage}
      />
    </Screen>
  );
}

function CardGap() {
  return <View style={{ height: 8 }} />;
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    paddingTop: 12,
    paddingBottom: 4,
  },
  mark: { width: 34, height: 34 },
  wordmark: {
    flex: 1,
    fontSize: 29,
    lineHeight: 36,
    letterSpacing: -0.3,
    fontFamily: WORDMARK_FONT,
  },
  macPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: 28,
    borderRadius: 999,
    paddingHorizontal: 10,
  },
  macText: { fontSize: 12, lineHeight: 16 },
  moreButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: 8,
  },
  flex: { flex: 1 },
  line: { paddingHorizontal: 20, marginBottom: 4 },
  reconnectRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 20,
    marginBottom: 4,
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingTop: 18,
    paddingBottom: 8,
  },
  skeletonWrap: { gap: 8 },
  skeletonCard: {
    height: 56,
    borderRadius: 18,
    alignItems: "flex-start",
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  skeletonBar: { width: "60%", height: 12, borderRadius: 6 },
  empty: { alignItems: "center", marginTop: 96, paddingHorizontal: 20 },
  emptyLine: { textAlign: "center", marginTop: 8 },
  hiddenFooter: { alignItems: "center", paddingTop: 16 },
  hiddenText: { fontSize: 13 },
  barWrap: { position: "absolute", left: 20, right: 20 },
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderRadius: 26,
    paddingLeft: 20,
    paddingRight: 10,
    paddingVertical: 10,
    minHeight: 56,
    shadowOpacity: 0.12,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 6,
  },
  barText: { flex: 1, fontSize: 15, lineHeight: 20 },
  sendCircle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
});
