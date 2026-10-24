import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActionSheetIOS,
  Alert,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  TextInput,
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
import { describeAddress } from "../src/pairing";
import { isOutdated, outdatedMessage, relaySupports } from "../src/compat";
import { respondFailureText, type ApprovalRequest } from "../src/approvals";
import { buildHomeList, projectsOf, withAlpha, type HomeItem } from "../src/homeList";
import { buildUsageStatsParams } from "../src/relay/params";
import { PRIVACY_URL, SUPPORT_URL } from "../src/config";
import { addArchived, removeArchived } from "../src/sessionActions";
import { loadPrefs, savePrefs, type Prefs } from "../src/storage";
import { parseSessionList, type SessionRow } from "../src/util";
import type { RelayStatus } from "../src/relay/client";
import { Dot } from "../src/ui/Dot";
import { ActionButton, NeedCard } from "../src/ui/NeedCard";
import { FilterChips } from "../src/ui/FilterChips";
import { HomeRow } from "../src/ui/HomeRow";
import { PressScale } from "../src/ui/PressScale";
import { Screen } from "../src/ui/Screen";
import { Text } from "../src/ui/Text";
import { UndoToast } from "../src/ui/UndoToast";
import { UsageSheet } from "../src/ui/UsageSheet";
import { buildMenuItems } from "../src/ui/menu";

// App version comes from app.json (expo.version) for the sheet title.
const APP_VERSION = Constants.expoConfig?.version;
// Loaded in app/_layout.tsx; falls back to the system font until it is.
const WORDMARK_FONT = "Nunito_800ExtraBold";

interface ToastState {
  message: string;
  onUndo?: () => void;
}

// Section header (home-list-v2: .sec h2) — small, uppercase, letter-spaced.
function SectionHeader({ title }: { title: string }) {
  const t = useTheme();
  return (
    <Text style={[styles.sectionHeader, { color: t.colors.subtext }]} accessibilityRole="header">
      {title}
    </Text>
  );
}

function IconButton({
  icon,
  label,
  onPress,
}: {
  icon: React.ComponentProps<typeof Feather>["name"];
  label: string;
  onPress: () => void;
}) {
  const t = useTheme();
  return (
    <PressScale
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={4}
      style={styles.iconButton}
    >
      <Feather name={icon} size={20} color={t.colors.text} />
    </PressScale>
  );
}

export default function SessionsScreen() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const {
    status,
    authFailed,
    relayProtocol,
    pendingApprovals,
    connectedUrl,
    rpc,
    unpair,
    demo,
    exitDemo,
    retryNow,
    respondApproval,
  } = useRelay();
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [usageVisible, setUsageVisible] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [project, setProject] = useState("All");
  const [olderOpen, setOlderOpen] = useState(false);
  const [outdatedDismissed, setOutdatedDismissed] = useState(false);
  // Tapping the Mac chip toggles the diagnostics line (how we are connected).
  const [showConnectionLine, setShowConnectionLine] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [prefs, setPrefs] = useState<Prefs>({
    showWorkOrders: false,
    archivedIds: [],
    showArchived: false,
  });

  // Ask-first answering is only offered against a current relay (P2/P3).
  const approvalsActive = status === "ready" && relaySupports(relayProtocol, "askFirst");
  // Buttons disable after a tap until the pending list changes; notes hold
  // the short feedback line per request key.
  const [busyKeys, setBusyKeys] = useState<string[]>([]);
  const [notes, setNotes] = useState<Record<string, string>>({});

  useEffect(() => {
    setBusyKeys([]);
    setNotes({});
  }, [pendingApprovals]);

  // Keep the relative times honest without recomputing on every keystroke.
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const showToast = useCallback((message: string, onUndo?: () => void) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ message, onUndo });
    toastTimer.current = setTimeout(() => setToast(null), 3200);
  }, []);

  const dismissToast = useCallback(() => {
    if (toastTimer.current) {
      clearTimeout(toastTimer.current);
      toastTimer.current = null;
    }
    setToast(null);
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, []);

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
      "The sample sessions disappear. Pair with your Mac to use Zode for real.",
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
        label: prefs.showWorkOrders ? "Hide automated tasks" : "Show automated tasks",
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

  const projects = useMemo(() => projectsOf(sessions), [sessions]);

  const pendingBySession = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const request of pendingApprovals) {
      if (request.kind !== "permission") continue;
      counts[request.sessionId] = (counts[request.sessionId] ?? 0) + 1;
    }
    return counts;
  }, [pendingApprovals]);

  const oldestAskBySession = useMemo(() => {
    const map = new Map<string, ApprovalRequest>();
    for (const request of pendingApprovals) {
      if (request.kind !== "permission") continue;
      if (!map.has(request.sessionId)) map.set(request.sessionId, request);
    }
    return map;
  }, [pendingApprovals]);

  const list = useMemo(
    () =>
      buildHomeList(sessions, {
        now: nowTick,
        project,
        query,
        showWorkOrders: prefs.showWorkOrders,
        showArchived: prefs.showArchived,
        archivedIds: prefs.archivedIds,
        pendingBySession,
      }),
    [sessions, nowTick, project, query, prefs, pendingBySession],
  );

  const openSession = useCallback(
    (item: HomeItem) => {
      router.push({
        pathname: "/session/[id]",
        params: { id: item.id, title: item.title },
      });
    },
    [router],
  );

  const decideApproval = useCallback(
    async (request: ApprovalRequest, decision: "allow" | "deny") => {
      if (busyKeys.includes(request.key)) return;
      setBusyKeys((current) => [...current, request.key]);
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      const result = await respondApproval(request.key, decision);
      if (result.ok) {
        setNotes((current) => ({
          ...current,
          [request.key]: decision === "allow" ? "Allowed" : "Denied",
        }));
      } else {
        setNotes((current) => ({ ...current, [request.key]: respondFailureText(result.message) }));
        setBusyKeys((current) => current.filter((key) => key !== request.key));
      }
    },
    [busyKeys, respondApproval],
  );

  const allowApproval = useCallback(
    (request: ApprovalRequest) => {
      if (request.risky) {
        Alert.alert("Allow this command?", request.detail, [
          { text: "Cancel", style: "cancel" },
          { text: "Allow", onPress: () => void decideApproval(request, "allow") },
        ]);
        return;
      }
      void decideApproval(request, "allow");
    },
    [decideApproval],
  );

  // Archive is local to this phone (order 17e: no delete from the phone).
  const archiveItem = useCallback(
    (item: HomeItem) => {
      updatePrefs({ archivedIds: addArchived(prefs.archivedIds, item.id) });
      showToast(`Archived “${item.title}”`, () => {
        updatePrefs({ archivedIds: removeArchived(prefs.archivedIds, item.id) });
      });
    },
    [prefs.archivedIds, updatePrefs, showToast],
  );

  const showOutdated = status === "ready" && !outdatedDismissed && isOutdated(relayProtocol);
  const offline = status === "reconnecting" || (status === "closed" && !authFailed);
  const statusLabel: Record<RelayStatus, string> = {
    connecting: "Connecting",
    ready: "Connected",
    reconnecting: "Reconnecting",
    closed: authFailed ? "Pairing rejected" : "Offline",
  };
  const listEmpty =
    list.needs.length +
      list.running.length +
      list.today.length +
      list.yesterday.length +
      list.older.length ===
    0;
  const filtering = project !== "All" || query.trim().length > 0;

  const renderNeed = (item: HomeItem, index: number) => {
    const ask = approvalsActive ? (oldestAskBySession.get(item.id) ?? null) : null;
    return (
      <NeedCard
        key={item.id}
        item={item}
        ask={ask}
        askMore={Math.max(0, item.askCount - 1)}
        busy={ask ? busyKeys.includes(ask.key) : false}
        note={ask ? notes[ask.key] : undefined}
        last={index === list.needs.length - 1}
        onAllow={ask ? () => allowApproval(ask) : undefined}
        onDeny={ask ? () => void decideApproval(ask, "deny") : undefined}
        onOpen={() => openSession(item)}
      />
    );
  };

  const renderHistoryRow = (items: HomeItem[]) => (item: HomeItem, index: number) => (
    <HomeRow
      key={item.id}
      item={item}
      last={index === items.length - 1}
      onOpen={() => openSession(item)}
      onArchive={() => archiveItem(item)}
    />
  );

  return (
    <Screen padded={false} style={styles.screen}>
      <Stack.Screen options={{ headerShown: false }} />

      <View style={styles.top}>
        <Text style={[styles.brand, { color: t.colors.text }]}>Zode</Text>
        <PressScale
          onPress={() => setShowConnectionLine((value) => !value)}
          accessibilityRole="button"
          accessibilityLabel={`Connection status: ${statusLabel[status]}. ${describeAddress(
            connectedUrl ?? "",
          )}`}
          hitSlop={8}
          style={[styles.macChip, { backgroundColor: t.colors.muted }]}
        >
          <Dot
            color={status === "ready" ? t.colors.ok : t.colors.danger}
            size={7}
            pulse={status === "reconnecting"}
          />
          <Text style={[styles.macText, { color: t.colors.subtext }]}>
            {status === "ready" ? "Mac" : "Offline"}
          </Text>
        </PressScale>
        <View style={styles.spacer} />
        <IconButton
          icon="search"
          label={searchOpen ? "Close search" : "Search conversations"}
          onPress={() => {
            if (searchOpen) setQuery("");
            setSearchOpen(!searchOpen);
          }}
        />
        <IconButton icon="more-horizontal" label="More options" onPress={showMenu} />
      </View>

      {searchOpen ? (
        <View style={styles.searchWrap}>
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search conversations"
            placeholderTextColor={t.colors.subtext}
            autoFocus
            autoCorrect={false}
            autoCapitalize="none"
            returnKeyType="search"
            accessibilityLabel="Search conversations"
            style={[styles.searchInput, { backgroundColor: t.colors.muted, color: t.colors.text }]}
          />
        </View>
      ) : undefined}

      <FilterChips projects={projects} selected={project} onSelect={setProject} />

      {showConnectionLine ? (
        <Text variant="caption" color="subtext" style={styles.connectionLine}>
          {status === "ready" ? describeAddress(connectedUrl ?? "") : statusLabel[status]}
        </Text>
      ) : undefined}

      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: 16,
          paddingBottom: insets.bottom + 124,
        }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void load()}
            tintColor={t.colors.subtext}
          />
        }
        keyboardShouldPersistTaps="handled"
      >
        {offline ? (
          <View
            style={[
              styles.offlineBanner,
              {
                backgroundColor: withAlpha(t.colors.danger, 0.1),
                borderColor: withAlpha(t.colors.danger, 0.35),
              },
            ]}
          >
            <View style={styles.offlineText}>
              <Text style={[styles.offlineTitle, { color: t.colors.text }]}>
                Can’t reach your Mac
              </Text>
              <Text style={[styles.offlineSub, { color: t.colors.subtext }]}>
                Is it awake, with Zode open, on the same Wi-Fi?
              </Text>
            </View>
            <ActionButton label="Retry" variant="quiet" onPress={retryNow} />
          </View>
        ) : status === "connecting" ? (
          <Text color="subtext" style={styles.plainLine}>
            Connecting…
          </Text>
        ) : authFailed ? (
          <Text color="danger" style={styles.plainLine}>
            Pairing rejected — unpair and pair again
          </Text>
        ) : undefined}

        {showOutdated ? (
          <View style={styles.outdatedRow}>
            <Text variant="caption" color="warn" style={styles.flex}>
              {outdatedMessage([
                "rename chats",
                "see usage",
                "attach photos and files",
                "use Ask first",
              ])}
            </Text>
            <Pressable
              onPress={() => setOutdatedDismissed(true)}
              accessibilityRole="button"
              accessibilityLabel="Dismiss update notice"
              hitSlop={8}
            >
              <Text variant="caption" color="warn" style={{ fontWeight: "600" }}>
                Dismiss
              </Text>
            </Pressable>
          </View>
        ) : undefined}

        {error ? (
          <Text variant="caption" color="danger" numberOfLines={2} style={styles.plainLine}>
            {error}
          </Text>
        ) : undefined}

        {list.needs.length > 0 ? (
          <View style={styles.section}>
            <SectionHeader title="Needs you" />
            <View style={[styles.group, { backgroundColor: t.colors.surface }]}>
              {list.needs.map(renderNeed)}
            </View>
          </View>
        ) : undefined}

        {list.running.length > 0 ? (
          <View style={styles.section}>
            <SectionHeader title="Running" />
            <View style={[styles.group, { backgroundColor: t.colors.surface }]}>
              {list.running.map((item, index) => (
                <HomeRow
                  key={item.id}
                  item={item}
                  running
                  last={index === list.running.length - 1}
                  onOpen={() => openSession(item)}
                />
              ))}
            </View>
          </View>
        ) : undefined}

        {list.today.length > 0 ? (
          <View style={styles.section}>
            <SectionHeader title="Today" />
            <View style={[styles.group, { backgroundColor: t.colors.surface }]}>
              {list.today.map(renderHistoryRow(list.today))}
            </View>
          </View>
        ) : undefined}

        {list.yesterday.length > 0 ? (
          <View style={styles.section}>
            <SectionHeader title="Yesterday" />
            <View style={[styles.group, { backgroundColor: t.colors.surface }]}>
              {list.yesterday.map(renderHistoryRow(list.yesterday))}
            </View>
          </View>
        ) : undefined}

        {list.older.length > 0 ? (
          olderOpen ? (
            <>
              <View style={styles.section}>
                <SectionHeader title="Earlier" />
                <View style={[styles.group, { backgroundColor: t.colors.surface }]}>
                  {list.older.map(renderHistoryRow(list.older))}
                </View>
              </View>
              <ActionButton
                label="Hide earlier"
                variant="quiet"
                onPress={() => setOlderOpen(false)}
                style={styles.wideAction}
              />
            </>
          ) : (
            <Pressable
              onPress={() => setOlderOpen(true)}
              accessibilityRole="button"
              accessibilityLabel={`Show ${list.older.length} earlier conversations`}
              hitSlop={4}
              style={[styles.olderLine, { backgroundColor: t.colors.surface }]}
            >
              <Text style={[styles.olderText, { color: t.colors.subtext }]}>
                {list.older.length} earlier conversation
                {list.older.length === 1 ? "" : "s"}
              </Text>
            </Pressable>
          )
        ) : undefined}

        {listEmpty ? (
          filtering ? (
            <Text style={[styles.emptyText, { color: t.colors.subtext }]}>
              No conversations match.
            </Text>
          ) : sessions.length === 0 ? (
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
            ) : (
              <View style={styles.empty}>
                <Text variant="display" style={{ fontSize: 22, lineHeight: 28 }}>
                  No sessions yet
                </Text>
                <Text variant="rowSubtitle" color="subtext" style={styles.emptyLine}>
                  Sessions running on your Mac will appear here.
                </Text>
              </View>
            )
          ) : undefined
        ) : undefined}

        {list.hiddenWorkOrders > 0 && !prefs.showWorkOrders ? (
          <Pressable
            onPress={toggleWorkOrders}
            accessibilityRole="button"
            accessibilityLabel={`Show ${list.hiddenWorkOrders} hidden automated tasks`}
            hitSlop={8}
            style={styles.hiddenFooter}
          >
            <Text color="subtext" style={styles.hiddenText}>
              {list.hiddenWorkOrders} automated {list.hiddenWorkOrders === 1 ? "task" : "tasks"}{" "}
              hidden · Show
            </Text>
          </Pressable>
        ) : undefined}
        {list.hiddenArchived > 0 && !prefs.showArchived ? (
          <Pressable
            onPress={() => updatePrefs({ showArchived: true })}
            accessibilityRole="button"
            accessibilityLabel={`Show ${list.hiddenArchived} archived conversations`}
            hitSlop={8}
            style={styles.hiddenFooter}
          >
            <Text color="subtext" style={styles.hiddenText}>
              {list.hiddenArchived} archived · Show
            </Text>
          </Pressable>
        ) : undefined}
      </ScrollView>

      <PressScale
        onPress={() => router.push("/new")}
        accessibilityRole="button"
        accessibilityLabel="New conversation"
        style={[
          styles.fab,
          { bottom: insets.bottom + 16, backgroundColor: t.colors.accent, shadowColor: t.colors.text },
        ]}
      >
        <Feather name="plus" size={26} color={t.colors.onAccent} />
      </PressScale>

      <UndoToast
        message={toast?.message ?? null}
        onUndo={
          toast?.onUndo
            ? () => {
                toast.onUndo?.();
                dismissToast();
              }
            : undefined
        }
      />

      <UsageSheet
        visible={usageVisible}
        onClose={() => setUsageVisible(false)}
        fetchAccountUsage={fetchAccountUsage}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  top: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 6,
  },
  brand: {
    fontSize: 22,
    lineHeight: 28,
    fontWeight: "800",
    letterSpacing: -0.5,
    fontFamily: WORDMARK_FONT,
  },
  macChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: 999,
    paddingLeft: 8,
    paddingRight: 10,
    paddingVertical: 4,
    marginLeft: 4,
    minHeight: 28,
  },
  macText: { fontSize: 12, lineHeight: 16 },
  connectionLine: { paddingHorizontal: 16, paddingTop: 2 },
  spacer: { flex: 1 },
  iconButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  searchWrap: { paddingHorizontal: 16, paddingBottom: 8 },
  searchInput: {
    fontSize: 15,
    lineHeight: 20,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 14,
  },
  offlineBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginTop: 4,
    marginBottom: 10,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderWidth: StyleSheet.hairlineWidth,
  },
  offlineText: { flex: 1 },
  offlineTitle: { fontSize: 13, lineHeight: 18, fontWeight: "700" },
  offlineSub: { fontSize: 12, lineHeight: 16, marginTop: 1 },
  outdatedRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 4,
    marginBottom: 4,
  },
  plainLine: { paddingHorizontal: 4, marginBottom: 4 },
  flex: { flex: 1 },
  section: { marginTop: 14 },
  sectionHeader: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "600",
    letterSpacing: 0.6,
    textTransform: "uppercase",
    marginHorizontal: 4,
    marginBottom: 6,
  },
  group: { borderRadius: 16, overflow: "hidden" },
  olderLine: {
    marginTop: 14,
    borderRadius: 16,
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: 14,
  },
  olderText: { fontSize: 13, lineHeight: 18 },
  wideAction: { marginTop: 10, alignSelf: "stretch" },
  emptyText: { fontSize: 14, lineHeight: 20, paddingVertical: 22, paddingHorizontal: 4 },
  empty: { alignItems: "center", marginTop: 96, paddingHorizontal: 20 },
  emptyLine: { textAlign: "center", marginTop: 8 },
  skeletonWrap: { gap: 8, marginTop: 8 },
  skeletonCard: {
    height: 56,
    borderRadius: 18,
    alignItems: "flex-start",
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  skeletonBar: { width: "60%", height: 12, borderRadius: 6 },
  hiddenFooter: { alignItems: "center", paddingTop: 16 },
  hiddenText: { fontSize: 13 },
  fab: {
    position: "absolute",
    right: 20,
    width: 58,
    height: 58,
    borderRadius: 29,
    alignItems: "center",
    justifyContent: "center",
    shadowOpacity: 0.22,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
});
