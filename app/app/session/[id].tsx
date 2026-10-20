import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  FlatList,
  KeyboardAvoidingView,
  LayoutAnimation,
  Platform,
  Pressable,
  StyleSheet,
  UIManager,
  View,
} from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useRelay, useSessionEvents } from "../../src/useRelay";
import { useTheme } from "../../src/theme";
import type { ChatItem } from "../../src/relay/reducer";
import {
  buildSessionSendParams,
  buildSessionSubscribeParams,
  buildSessionUsageParams,
  buildUsageStatsParams,
} from "../../src/relay/params";
import { retryInSeconds } from "../../src/relay/backoff";
import {
  buildRenameParams,
  buildSetModelParams,
  buildSetThoughtLevelParams,
  emptyChatSettings,
  parseChatSettings,
  type ChatSettings,
  type ModelOption,
} from "../../src/chatSettings";
import {
  addArchived,
  deleteSession,
  isArchived,
  removeArchived,
} from "../../src/sessionActions";
import { loadPrefs, savePrefs } from "../../src/storage";
import {
  isSystemLikeUserText,
  mergeHistoryWithLive,
  messagesToItems,
} from "../../src/history";
import { useScrollPin } from "../../src/scrollPin";
import { Composer } from "../../src/ui/Composer";
import { Dot, useReduceMotion } from "../../src/ui/Dot";
import { Markdown } from "../../src/ui/Markdown";
import { ModelSheet } from "../../src/ui/ModelSheet";
import { Pill } from "../../src/ui/Pill";
import { RenameModal } from "../../src/ui/RenameModal";
import { Skeleton } from "../../src/ui/Skeleton";
import { Text } from "../../src/ui/Text";
import { ThinkingDots } from "../../src/ui/ThinkingDots";
import { ToolRow } from "../../src/ui/ToolRow";
import { UsageSheet } from "../../src/ui/UsageSheet";

// LayoutAnimation for expand/collapse needs the experimental flag on Android.
if (Platform.OS === "android") {
  UIManager.setLayoutAnimationEnabledExperimental?.(true);
}

function shortError(e: unknown): string {
  const message = e instanceof Error ? e.message : typeof e === "string" ? e : "request failed";
  return message.length > 160 ? `${message.slice(0, 160)}…` : message;
}

function formatElapsed(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

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
        {retryAt ? `Reconnecting, next try in ${retryInSeconds(retryAt, now)} s` : "Reconnecting…"}
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

export default function SessionScreen() {
  const params = useLocalSearchParams<{
    id?: string | string[];
    title?: string | string[];
    focus?: string | string[];
  }>();
  const sessionId = (Array.isArray(params.id) ? params.id[0] : params.id) ?? "";
  const routeTitle = Array.isArray(params.title) ? params.title[0] : params.title;
  const autoFocusComposer = (Array.isArray(params.focus) ? params.focus[0] : params.focus) === "1";

  const t = useTheme();
  const router = useRouter();
  const { status, client, rpc, retryAt, reconnectAttempts, retryNow } = useRelay();
  const session = useSessionEvents(sessionId);

  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [archived, setArchived] = useState(false);
  const [renamedTitle, setRenamedTitle] = useState<string | null>(null);
  const [renameVisible, setRenameVisible] = useState(false);
  const [modelSheetVisible, setModelSheetVisible] = useState(false);
  const [usageSheetVisible, setUsageSheetVisible] = useState(false);
  const [chatSettings, setChatSettings] = useState<ChatSettings>(() => emptyChatSettings());

  useEffect(() => {
    void (async () => {
      const prefs = await loadPrefs();
      setArchived(isArchived(prefs.archivedIds, sessionId));
    })();
  }, [sessionId]);

  const [historyState, setHistoryState] = useState<"loading" | "ready" | "error">("loading");
  const [historyItems, setHistoryItems] = useState<ChatItem[]>([]);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const bootAttempt = useRef(0);

  const bootstrap = useCallback(async () => {
    if (!sessionId) return;
    const attempt = ++bootAttempt.current;
    setHistoryState("loading");
    setHistoryError(null);
    setResumeError(null);
    let resumeFailure: string | null = null;
    try {
      const resumeResult = await rpc("session/resume", { sessionId });
      if (attempt === bootAttempt.current) {
        setChatSettings(parseChatSettings(resumeResult));
      }
    } catch (e: unknown) {
      resumeFailure = shortError(e);
    }
    try {
      await rpc("session/subscribe", buildSessionSubscribeParams(sessionId));
    } catch {}
    try {
      const result = await rpc("session/messages", { sessionId, limit: 50 });
      if (attempt !== bootAttempt.current) return;
      setHistoryItems(messagesToItems(result));
      setResumeError(resumeFailure);
      setHistoryState("ready");
    } catch (e: unknown) {
      if (attempt !== bootAttempt.current) return;
      setHistoryError(shortError(e));
      setResumeError(resumeFailure);
      setHistoryState("error");
    }
  }, [sessionId, rpc]);

  useEffect(() => {
    if (sessionId && status === "ready") void bootstrap();
  }, [sessionId, status, bootstrap]);

  const items = mergeHistoryWithLive(historyItems, session.items);

  // Elapsed time for the "Working..." indicator.
  const [elapsed, setElapsed] = useState<number | null>(null);
  useEffect(() => {
    if (!session.running) {
      setElapsed(null);
      return;
    }
    const startedAt = Date.now();
    setElapsed(0);
    const timer = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [session.running]);

  const stop = useCallback(async () => {
    try {
      await rpc("session/stop", { sessionId });
    } catch {}
  }, [rpc, sessionId]);

  // Archive is local to this phone; delete removes it on the Mac. Both
  // return to the home screen on success.
  const toggleArchive = useCallback(async () => {
    const prefs = await loadPrefs();
    const archivedIds = archived
      ? removeArchived(prefs.archivedIds, sessionId)
      : addArchived(prefs.archivedIds, sessionId);
    await savePrefs({ ...prefs, archivedIds });
    setArchived(!archived);
    router.back();
  }, [archived, sessionId, router]);

  const applyRename = useCallback(
    async (next: string) => {
      setRenameVisible(false);
      if (!client) {
        Alert.alert("Could not rename", "Not connected.", [{ text: "OK" }]);
        return;
      }
      try {
        const result = await client.rpc("session/rename", buildRenameParams(sessionId, next));
        if ((result as { status?: unknown } | null)?.status !== "accepted") {
          throw new Error("The rename was not accepted.");
        }
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        setRenamedTitle(next.trim().slice(0, 120));
      } catch (e: unknown) {
        Alert.alert("Could not rename", shortError(e), [{ text: "OK" }]);
      }
    },
    [client, sessionId],
  );

  const applyModel = useCallback(
    async (option: ModelOption, reasoningLevel?: string) => {
      setModelSheetVisible(false);
      if (!client) return;
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      try {
        await client.rpc("session/setModel", buildSetModelParams(sessionId, option, reasoningLevel));
        setChatSettings((current) => ({
          ...current,
          model: {
            providerId: option.providerId,
            modelId: option.modelId,
            label: option.modelId,
            reasoningLevel: reasoningLevel ?? current.model?.reasoningLevel ?? null,
          },
        }));
      } catch (e: unknown) {
        Alert.alert("Could not change the model", shortError(e), [{ text: "OK" }]);
      }
    },
    [client, sessionId],
  );

  const applyLevel = useCallback(
    async (level: string) => {
      setModelSheetVisible(false);
      if (level === chatSettings.thoughtLevel) return;
      if (!client) return;
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      try {
        await client.rpc("session/setThoughtLevel", buildSetThoughtLevelParams(sessionId, level));
        setChatSettings((current) => ({ ...current, thoughtLevel: level }));
      } catch (e: unknown) {
        Alert.alert("Could not change the thinking level", shortError(e), [{ text: "OK" }]);
      }
    },
    [chatSettings.thoughtLevel, client, sessionId],
  );

  const fetchSessionUsage = useCallback(
    () => rpc("session/usage", buildSessionUsageParams(sessionId)),
    [rpc, sessionId],
  );

  const fetchAccountUsage = useCallback(
    (range: "7d" | "30d" | "all") => rpc("usage/stats", buildUsageStatsParams(range)),
    [rpc],
  );

  const deleteConversation = useCallback(async () => {
    if (session.running) {
      Alert.alert("Stop it first", undefined, [{ text: "OK" }]);
      return;
    }
    if (!client) {
      Alert.alert("Could not delete", "Not connected.", [{ text: "OK" }]);
      return;
    }
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    try {
      await deleteSession(client, sessionId);
      const prefs = await loadPrefs();
      await savePrefs({
        ...prefs,
        archivedIds: removeArchived(prefs.archivedIds, sessionId),
      });
      router.back();
    } catch (e: unknown) {
      Alert.alert("Could not delete", shortError(e), [{ text: "OK" }]);
    }
  }, [client, sessionId, session.running, router]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || sending || !sessionId) return;
    setSending(true);
    setSendError(null);
    setDraft("");
    try {
      await rpc("session/send", buildSessionSendParams(sessionId, text));
    } catch (e: unknown) {
      setSendError(shortError(e));
    } finally {
      setSending(false);
    }
  }, [draft, sending, sessionId, rpc]);

  const currentTitle = renamedTitle ?? session.title ?? routeTitle ?? "";

  const showSessionMenu = useCallback(() => {
    void Alert.alert(
      "Session",
      undefined,
      [
        { text: "Rename", onPress: () => setRenameVisible(true) },
        { text: "Model and thinking", onPress: () => setModelSheetVisible(true) },
        { text: "Usage", onPress: () => setUsageSheetVisible(true) },
        ...(session.running
          ? [
              {
                text: "Stop session",
                style: "destructive" as const,
                onPress: () => void stop(),
              },
            ]
          : []),
        {
          text: archived ? "Unarchive" : "Archive",
          onPress: () => void toggleArchive(),
        },
        {
          text: "Delete conversation",
          style: "destructive" as const,
          onPress: () => void deleteConversation(),
        },
        { text: "Cancel", style: "cancel" as const },
      ],
    );
  }, [session.running, archived, toggleArchive, deleteConversation, stop]);

  const headerRight = useCallback(
    () => (
      <Pressable
        onPress={showSessionMenu}
        accessibilityRole="button"
        accessibilityLabel="Session actions"
        hitSlop={8}
        style={{ paddingHorizontal: 8 }}
      >
        <Feather name="more-horizontal" size={22} color={t.colors.text} />
      </Pressable>
    ),
    [showSessionMenu, t],
  );

  // Scroll pinning: stick to the bottom while streaming unless the user
  // drags; offer "Jump to latest" when they scroll away.
  const listRef = useRef<FlatList<ChatItem>>(null);
  const {
    onScroll,
    onScrollBeginDrag,
    onMomentumScrollEnd,
    onContentSizeChange,
    jumpToEnd,
    showJump,
  } = useScrollPin(listRef);

  const renderItem = useCallback(({ item }: { item: ChatItem }) => <ChatRow item={item} />, []);
  const keyExtractor = useCallback((item: ChatItem) => item.key, []);

  return (
    <KeyboardAvoidingView
      style={[styles.flex, { backgroundColor: t.colors.bg }]}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={88}
    >
      <Stack.Screen
        options={{ title: currentTitle || "Session", headerRight }}
      />

      {status === "reconnecting" ? (
        <ReconnectingLine
          retryAt={retryAt}
          showRetry={reconnectAttempts >= 3}
          onRetry={retryNow}
        />
      ) : undefined}
      {chatSettings.model ? (
        <Text variant="caption" color="subtext" numberOfLines={1} style={styles.subtitleLine}>
          {chatSettings.model.modelId}
          {chatSettings.thoughtLevel ? ` · ${chatSettings.thoughtLevel}` : ""}
        </Text>
      ) : undefined}
      {session.permissionRequest ? (
        <Text variant="caption" color="warn" numberOfLines={2} style={styles.banner}>
          Permission requested
          {session.permissionRequest.toolName ? ` for ${session.permissionRequest.toolName}` : ""}.
          Approve it on the Mac — this view is read-only.
        </Text>
      ) : undefined}

      <FlatList
        ref={listRef}
        style={styles.flex}
        data={items}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        initialNumToRender={12}
        windowSize={7}
        removeClippedSubviews={false}
        onScroll={onScroll}
        onScrollBeginDrag={onScrollBeginDrag}
        onMomentumScrollEnd={onMomentumScrollEnd}
        onContentSizeChange={onContentSizeChange}
        scrollEventThrottle={100}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 12 }}
        ListEmptyComponent={
          historyState === "loading" ? (
            <Skeleton />
          ) : historyState === "error" ? undefined : items.length === 0 && !resumeError ? (
            <Text variant="rowSubtitle" color="subtext" style={styles.empty}>
              No messages yet
            </Text>
          ) : undefined
        }
        ListFooterComponent={
          <View>
            {session.running && elapsed !== null ? (
              <View style={styles.working}>
                <Dot color={t.colors.accent} pulse />
                <Text variant="rowSubtitle" color="subtext">
                  Working…
                </Text>
                <ThinkingDots />
                <Text variant="rowSubtitle" color="subtext">
                  {formatElapsed(elapsed)}
                </Text>
              </View>
            ) : undefined}
            {historyState === "error" ? (
              <View style={styles.noticeBox}>
                <Text variant="bodySmall" color="danger">
                  Could not load history
                </Text>
                <Text variant="caption" color="subtext" numberOfLines={2}>
                  {historyError}
                </Text>
                {resumeError ? (
                  <Text variant="caption" color="subtext" numberOfLines={2}>
                    Resume also failed: {resumeError}
                  </Text>
                ) : undefined}
                <Pill
                  label="Retry"
                  variant="quiet"
                  onPress={() => void bootstrap()}
                  style={styles.retry}
                />
              </View>
            ) : resumeError ? (
              <View style={styles.noticeBox}>
                <Text variant="caption" color="warn" numberOfLines={2}>
                  Could not resume session: {resumeError}
                </Text>
                <Pill
                  label="Retry"
                  variant="quiet"
                  onPress={() => void bootstrap()}
                  style={styles.retry}
                />
              </View>
            ) : undefined}
          </View>
        }
      />

      {sendError ? (
        <Text variant="caption" color="danger" numberOfLines={2} style={styles.banner}>
          {sendError}
        </Text>
      ) : undefined}

      <View>
        {showJump && items.length > 0 ? (
          <Pressable
            onPress={jumpToEnd}
            accessibilityRole="button"
            accessibilityLabel="Jump to latest"
            style={[styles.jump, { backgroundColor: t.colors.surface, borderColor: t.colors.border }]}
          >
            <Feather name="arrow-down" size={16} color={t.colors.text} />
          </Pressable>
        ) : undefined}
        <Composer
          value={draft}
          onChangeText={setDraft}
          onSend={() => void send()}
          onStop={() => void stop()}
          running={session.running}
          sending={sending}
          autoFocus={autoFocusComposer}
        />
      </View>

      <RenameModal
        visible={renameVisible}
        title={currentTitle}
        onClose={() => setRenameVisible(false)}
        onSave={(next) => void applyRename(next)}
      />
      <ModelSheet
        visible={modelSheetVisible}
        onClose={() => setModelSheetVisible(false)}
        running={session.running}
        models={chatSettings.models}
        currentModelId={chatSettings.model?.modelId ?? null}
        currentLevel={chatSettings.thoughtLevel}
        thoughtLevels={chatSettings.thoughtLevels}
        onPickModel={(option, level) => void applyModel(option, level)}
        onPickLevel={(level) => void applyLevel(level)}
      />
      <UsageSheet
        visible={usageSheetVisible}
        onClose={() => setUsageSheetVisible(false)}
        conversation={{
          contextUsed: chatSettings.contextUsed,
          contextWindow: chatSettings.contextWindow,
        }}
        fetchSessionUsage={fetchSessionUsage}
        fetchAccountUsage={fetchAccountUsage}
      />
    </KeyboardAvoidingView>
  );
}

// Rows are memoized: unchanged items skip re-render when the elapsed timer
// or a streaming delta updates the list (Markdown itself is memoized too).
const ChatRow = React.memo(function ChatRow({ item }: { item: ChatItem }) {
  if (item.kind === "user") {
    return isSystemLikeUserText(item.text) ? (
      <SystemRow text={item.text} />
    ) : (
      <UserBubble text={item.text} />
    );
  }
  if (item.kind === "assistant") return <AssistantBlock item={item} />;
  if (item.kind === "reasoning") {
    return <ReasoningRow text={item.text} streaming={item.streaming} />;
  }
  if (item.kind === "tool") return <ToolBlock item={item} />;
  if (item.kind === "error") {
    return (
      <Text variant="bodySmall" color="danger" style={styles.errorText}>
        {item.text}
      </Text>
    );
  }
  return (
    <Text variant="caption" color="subtext" style={styles.noticeText}>
      {item.text}
    </Text>
  );
});

const UserBubble = React.memo(function UserBubble({ text }: { text: string }) {
  const t = useTheme();
  return (
    <View style={styles.userRow}>
      <View style={[styles.bubble, { backgroundColor: t.colors.muted }]}>
        <Text variant="body" selectable>
          {text}
        </Text>
      </View>
    </View>
  );
});

// Harness-injected user text (task notifications, reminders): collapsed
// muted row with a 120-character preview, tap to expand.
const SystemRow = React.memo(function SystemRow({ text }: { text: string }) {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  const preview = text.length > 120 ? `${text.slice(0, 120)}…` : text;
  return (
    <Pressable
      onPress={() => setOpen(!open)}
      accessibilityRole="button"
      accessibilityLabel={`System message: ${preview}`}
      style={[styles.systemRow, { backgroundColor: t.colors.muted }]}
    >
      <Text variant="caption" color="subtext" style={{ fontWeight: "600" }}>
        System message
      </Text>
      <Text
        variant="caption"
        color="subtext"
        numberOfLines={open ? undefined : 1}
        selectable={open}
      >
        {open ? text : preview}
      </Text>
    </Pressable>
  );
});

const AssistantBlock = React.memo(function AssistantBlock({ item }: { item: ChatItem }) {
  if (item.streaming) {
    // plain text while streaming: markdown of partial text flickers
    return (
      <Text variant="body" selectable style={styles.assistant}>
        {item.text}▍
      </Text>
    );
  }
  return (
    <View style={styles.assistant}>
      <Markdown>{item.text}</Markdown>
    </View>
  );
});

const ReasoningRow = React.memo(function ReasoningRow({
  text,
  streaming,
}: {
  text: string;
  streaming?: boolean;
}) {
  const t = useTheme();
  const reduceMotion = useReduceMotion();
  const [open, setOpen] = useState(false);
  return (
    <View style={styles.reasoning}>
      <Pressable
        onPress={() => {
          if (!reduceMotion) {
            LayoutAnimation.configureNext({
              duration: 200,
              update: { type: LayoutAnimation.Types.easeInEaseOut },
              create: {
                type: LayoutAnimation.Types.easeInEaseOut,
                property: LayoutAnimation.Properties.opacity,
              },
            });
          }
          setOpen(!open);
        }}
        accessibilityRole="button"
        accessibilityLabel="Reasoning"
        hitSlop={4}
        style={styles.reasoningHeader}
      >
        <Feather
          name={open ? "chevron-down" : "chevron-right"}
          size={14}
          color={t.colors.subtext}
        />
        <Text variant="bodySmall" color="subtext">
          Thinking
        </Text>
        {streaming ? <ThinkingDots /> : undefined}
      </Pressable>
      {open ? (
        <Text variant="bodySmall" color="subtext" selectable style={styles.reasoningText}>
          {text}
        </Text>
      ) : undefined}
    </View>
  );
});

const ToolBlock = React.memo(function ToolBlock({ item }: { item: ChatItem }) {
  const input = "toolInput" in item && typeof item.toolInput === "string" ? item.toolInput : "";
  const output =
    "toolOutput" in item && typeof item.toolOutput === "string" ? item.toolOutput : "";
  return (
    <ToolRow
      name={item.toolName ?? "Tool"}
      summary={toolSummary(item, input)}
      input={input || undefined}
      output={output || undefined}
    />
  );
});

// One-line mono summary: file path, command, query — else the tool state.
function toolSummary(item: ChatItem, input: string): string {
  if (input) {
    try {
      const parsed = JSON.parse(input) as Record<string, unknown> | null;
      const candidate =
        parsed?.filePath ?? parsed?.path ?? parsed?.command ?? parsed?.pattern ?? parsed?.query;
      if (typeof candidate === "string" && candidate) {
        return firstLine(candidate);
      }
    } catch {}
    return firstLine(input);
  }
  switch (item.toolState) {
    case "scheduled":
      return "queued";
    case "started":
      return "running";
    case "result":
      return "done";
    default:
      return item.toolState ?? "";
  }
}

function firstLine(text: string): string {
  const line = text.split("\n", 1)[0] ?? text;
  return line.length > 80 ? `${line.slice(0, 80)}…` : line;
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  subtitleLine: { paddingHorizontal: 20, paddingTop: 2 },
  reconnectRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 20,
    paddingTop: 6,
  },
  banner: { paddingHorizontal: 20, paddingTop: 6 },
  userRow: { flexDirection: "row", justifyContent: "flex-end", marginVertical: 4 },
  bubble: {
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 10,
    maxWidth: "85%",
    marginVertical: 4,
  },
  systemRow: { borderRadius: 12, padding: 10, marginVertical: 4, gap: 2 },
  assistant: { marginVertical: 4 },
  reasoning: { marginVertical: 4 },
  reasoningHeader: {
    minHeight: 32,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  reasoningText: { paddingLeft: 18, marginTop: 2 },
  errorText: { marginVertical: 4 },
  noticeText: { textAlign: "center", marginVertical: 4 },
  working: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 12,
  },
  noticeBox: {
    alignItems: "flex-start",
    gap: 4,
    paddingVertical: 12,
  },
  retry: { marginTop: 4 },
  empty: { textAlign: "center", marginTop: 64 },
  jump: {
    position: "absolute",
    top: -46,
    right: 20,
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1,
  },
});
