import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActionSheetIOS,
  Alert,
  FlatList,
  Image,
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
import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import { useRelay, useSessionEvents } from "../../src/useRelay";
import { outdatedMessage, relaySupports } from "../../src/compat";
import { respondFailureText, type ApprovalRequest } from "../../src/approvals";
import { useTheme } from "../../src/theme";
import type { ChatItem } from "../../src/relay/reducer";
import {
  buildAttachmentUploadParams,
  buildSessionSendParams,
  buildSessionSubscribeParams,
  buildSessionUsageParams,
  buildUsageStatsParams,
} from "../../src/relay/params";
import { retryInSeconds } from "../../src/relay/backoff";
import {
  buildRenameParams,
  buildSetModeParams,
  buildSetModelParams,
  buildSetThoughtLevelParams,
  emptyChatSettings,
  parseChatSettings,
  permissionLabel,
  thinkingLabel,
  type ChatSettings,
  type ModelOption,
} from "../../src/chatSettings";
import {
  addArchived,
  isArchived,
  removeArchived,
} from "../../src/sessionActions";
import { loadPrefs, savePrefs } from "../../src/storage";
import { canAttach, describeAttachment, formatBytes, guessMime, MAX_ATTACHMENTS } from "../../src/attachments";
import {
  isSystemLikeUserText,
  mergeHistoryWithLive,
  messagesToItems,
} from "../../src/history";
import { useScrollPin } from "../../src/scrollPin";
import { AttachmentTray, type TrayAttachment } from "../../src/ui/AttachmentTray";
import { ApprovalSheet, type ApprovalDecision } from "../../src/ui/ApprovalSheet";
import { Composer } from "../../src/ui/Composer";
import { Dot, useReduceMotion } from "../../src/ui/Dot";
import { Markdown } from "../../src/ui/Markdown";
import { ModelSheet } from "../../src/ui/ModelSheet";
import { PermissionSheet, type PhoneMode } from "../../src/ui/PermissionSheet";
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

// A feature this phone supports but the Mac's Zode does not.
function showOutdatedAlert(feature: string) {
  Alert.alert("Update Zode on your Mac", outdatedMessage([feature]), [{ text: "OK" }]);
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
  const { status, client, relayProtocol, pendingApprovals, rpc, retryAt, reconnectAttempts, retryNow, respondApproval } = useRelay();
  const session = useSessionEvents(sessionId);

  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [archived, setArchived] = useState(false);
  const [renamedTitle, setRenamedTitle] = useState<string | null>(null);
  const [renameVisible, setRenameVisible] = useState(false);
  const [modelSheetVisible, setModelSheetVisible] = useState(false);
  const [usageSheetVisible, setUsageSheetVisible] = useState(false);
  const [permissionVisible, setPermissionVisible] = useState(false);
  const [attachments, setAttachments] = useState<TrayAttachment[]>([]);
  const [optimisticItems, setOptimisticItems] = useState<ChatItem[]>([]);
  const attachmentKey = useRef(0);
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

  const liveItems = mergeHistoryWithLive(historyItems, session.items);
  const items = useMemo(() => [...liveItems, ...optimisticItems], [liveItems, optimisticItems]);

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

  // ---- attachments (order 17e) ----
  function patchAttachment(key: string, patch: Partial<TrayAttachment>) {
    setAttachments((current) =>
      current.map((entry) => (entry.key === key ? { ...entry, ...patch } : entry)),
    );
  }

  async function uploadAttachment(item: TrayAttachment) {
    if (!client) {
      patchAttachment(item.key, { state: "failed" });
      return;
    }
    patchAttachment(item.key, { state: "uploading" });
    try {
      const result = await client.rpc(
        "attachment/upload",
        buildAttachmentUploadParams({
          sessionId,
          fileName: item.fileName,
          mime: item.mime,
          dataBase64: item.dataBase64 ?? "",
        }),
        undefined,
        90_000,
      );
      const data = (result ?? {}) as Record<string, unknown>;
      if (typeof data.ref !== "string" || !data.ref) throw new Error("upload failed");
      patchAttachment(item.key, {
        state: "ready",
        ref: data.ref,
        bytes: typeof data.bytes === "number" ? data.bytes : item.sizeBytes,
      });
    } catch {
      patchAttachment(item.key, { state: "failed" });
    }
  }

  interface PickedAttachment {
    fileName: string;
    mime: string;
    sizeBytes: number;
    localUri?: string;
    dataBase64?: string;
  }

  function addPicked(picked: PickedAttachment[]) {
    const next: TrayAttachment[] = [];
    let count = attachments.length;
    for (const item of picked) {
      if (count >= MAX_ATTACHMENTS) {
        Alert.alert("Limit reached", "At most 6 attachments per message.", [{ text: "OK" }]);
        break;
      }
      if (!canAttach(count, item.sizeBytes)) {
        Alert.alert(item.fileName, "is larger than 8 MB", [{ text: "OK" }]);
        continue;
      }
      count += 1;
      attachmentKey.current += 1;
      next.push({
        key: `att-${attachmentKey.current}`,
        fileName: item.fileName,
        mime: item.mime,
        sizeBytes: item.sizeBytes,
        localUri: item.localUri,
        dataBase64: item.dataBase64,
        isImage: item.mime.startsWith("image/"),
        state: "uploading",
      });
    }
    if (next.length === 0) return;
    setAttachments((current) => [...current, ...next]);
    for (const item of next) void uploadAttachment(item);
  }

  async function pickFromLibrary() {
    const remaining = MAX_ATTACHMENTS - attachments.length;
    if (remaining <= 0) {
      Alert.alert("Limit reached", "At most 6 attachments per message.", [{ text: "OK" }]);
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsMultipleSelection: true,
      selectionLimit: remaining,
      quality: 0.7,
      base64: true,
    });
    if (result.canceled) return;
    addPicked(
      result.assets.map((asset) => ({
        fileName: asset.fileName ?? `photo-${Date.now()}.jpg`,
        mime: asset.mimeType ?? guessMime(asset.fileName ?? "photo.jpg"),
        sizeBytes: asset.fileSize ?? Math.round((asset.base64?.length ?? 0) * 0.75),
        localUri: asset.uri,
        dataBase64: asset.base64 ?? "",
      })),
    );
  }

  async function pickFromCamera() {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      Alert.alert("Camera unavailable", "Camera permission was denied.", [{ text: "OK" }]);
      return;
    }
    const result = await ImagePicker.launchCameraAsync({ quality: 0.7, base64: true });
    if (result.canceled) return;
    const asset = result.assets[0];
    if (!asset) return;
    addPicked([
      {
        fileName: asset.fileName ?? `photo-${Date.now()}.jpg`,
        mime: asset.mimeType ?? guessMime(asset.fileName ?? "photo.jpg"),
        sizeBytes: asset.fileSize ?? Math.round((asset.base64?.length ?? 0) * 0.75),
        localUri: asset.uri,
        dataBase64: asset.base64 ?? "",
      },
    ]);
  }

  async function pickFiles() {
    const result = await DocumentPicker.getDocumentAsync({
      type: "*/*",
      multiple: true,
      copyToCacheDirectory: true,
    });
    if (result.canceled) return;
    const picked: PickedAttachment[] = [];
    for (const asset of result.assets) {
      // relay rejects mimes without a type/subtype shape
      const mime =
        typeof asset.mimeType === "string" && asset.mimeType.includes("/")
          ? asset.mimeType
          : guessMime(asset.name);
      const file = new File(asset.uri);
      const dataBase64 = await file.base64();
      picked.push({
        fileName: asset.name,
        mime,
        sizeBytes: asset.size ?? Math.round((dataBase64.length * 3) / 4),
        dataBase64,
      });
    }
    addPicked(picked);
  }

  function showAddSheet() {
    if (!relaySupports(relayProtocol, "attachments")) {
      showOutdatedAlert("attach photos and files");
      return;
    }
    const options = [
      { key: "library", label: "Photo library" },
      { key: "camera", label: "Take photo" },
      { key: "files", label: "Files" },
      { key: "cancel", label: "Cancel" },
    ];
    const run = (key: string | undefined) => {
      if (key === "library") void pickFromLibrary();
      if (key === "camera") void pickFromCamera();
      if (key === "files") void pickFiles();
    };
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: options.map((option) => option.label),
          cancelButtonIndex: 3,
        },
        (index: number) => run(options[index]?.key),
      );
    } else {
      Alert.alert(
        "Add attachment",
        undefined,
        options.map((option) => ({
          text: option.label,
          style: option.key === "cancel" ? ("cancel" as const) : ("default" as const),
          onPress: () => run(option.key),
        })),
      );
    }
  }

  // Archive is local to this phone. Deleting conversations from the phone is
  // not supported (order 17e).
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

  const applyMode = useCallback(
    async (mode: PhoneMode) => {
      setPermissionVisible(false);
      if (!client) return;
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      try {
        await client.rpc("session/setMode", buildSetModeParams(sessionId, mode));
        setChatSettings((current) => ({ ...current, mode }));
      } catch (e: unknown) {
        Alert.alert("Could not change the permission level", shortError(e), [{ text: "OK" }]);
      }
    },
    [client, sessionId],
  );

  const fetchSessionUsage = useCallback(
    () => rpc("session/usage", buildSessionUsageParams(sessionId)),
    [rpc, sessionId],
  );

  const fetchAccountUsage = useCallback(
    (range: "7d" | "30d" | "all") => rpc("usage/stats", buildUsageStatsParams(range)),
    [rpc],
  );

  const send = useCallback(async () => {
    const ready = attachments.filter((item) => item.state === "ready" && item.ref);
    const text = draft.trim() || (ready.length > 0 ? "See attached." : "");
    if (!text || sending || !sessionId) return;
    if (attachments.some((item) => item.state !== "ready")) return;
    setSending(true);
    setSendError(null);
    setDraft("");
    attachmentKey.current += 1;
    const optimisticKey = `optimistic-${attachmentKey.current}`;
    const optimistic: ChatItem = {
      key: optimisticKey,
      kind: "user",
      text,
      attachments: ready.map((item) => ({
        label: item.fileName,
        image: item.isImage,
        sizeBytes: item.sizeBytes,
        localUri: item.localUri,
      })),
    };
    setOptimisticItems((current) => [...current, optimistic]);
    try {
      const sent = ready.map((item) => ({
        ref: item.ref as string,
        fileName: item.fileName,
        mime: item.mime,
        bytes: item.bytes ?? item.sizeBytes,
      }));
      await rpc(
        "session/send",
        buildSessionSendParams(sessionId, text, sent.length > 0 ? sent : undefined),
      );
      // accepted: clear the tray (the optimistic bubble keeps the chips)
      setAttachments([]);
    } catch (e: unknown) {
      setOptimisticItems((current) => current.filter((item) => item.key !== optimisticKey));
      setDraft((current) => (current ? current : text));
      setSendError(shortError(e));
    } finally {
      setSending(false);
    }
  }, [attachments, draft, sending, sessionId, rpc]);

  // Once the live stream echoes the user text, drop the local optimistic copy.
  useEffect(() => {
    if (optimisticItems.length === 0) return;
    const texts = new Set(optimisticItems.map((item) => item.text));
    if (session.items.some((item) => item.kind === "user" && texts.has(item.text))) {
      setOptimisticItems((current) =>
        current.filter((item) => !texts.has(item.text)),
      );
    }
  }, [session.items, optimisticItems]);

  const openPermissionSheet = useCallback(() => {
    if (!relaySupports(relayProtocol, "askFirst")) {
      showOutdatedAlert("use Ask first");
      return;
    }
    setPermissionVisible(true);
  }, [relayProtocol]);

  // ---- Ask-first approvals ----
  const approvalsActive = status === "ready" && relaySupports(relayProtocol, "askFirst");
  const approvalRequests = approvalsActive
    ? pendingApprovals.filter(
        (request) => request.sessionId === sessionId && request.kind === "permission",
      )
    : [];
  const barRequest = approvalRequests[0];
  const barRequestKey = barRequest?.key ?? null;
  const [approvalOpen, setApprovalOpen] = useState(false);
  const [approvalBusy, setApprovalBusy] = useState<string | null>(null);
  const [approvalNote, setApprovalNote] = useState<string | null>(null);

  // The request changing (answered here or on the Mac) resets the bar.
  useEffect(() => {
    setApprovalBusy(null);
    setApprovalNote(null);
  }, [barRequestKey]);

  const sendDecision = useCallback(
    async (request: ApprovalRequest, decision: ApprovalDecision) => {
      if (approvalBusy) return;
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      setApprovalBusy(request.key);
      const result = await respondApproval(request.key, decision);
      if (result.ok) {
        setApprovalNote(decision === "allow" ? "Allowed" : "Denied");
      } else {
        setApprovalNote(respondFailureText(result.message));
        setApprovalBusy(null);
      }
    },
    [approvalBusy, respondApproval],
  );

  const allowRequest = useCallback(
    (request: ApprovalRequest) => {
      if (request.risky) {
        Alert.alert("Allow this command?", request.detail, [
          { text: "Cancel", style: "cancel" },
          { text: "Allow", onPress: () => void sendDecision(request, "allow") },
        ]);
        return;
      }
      void sendDecision(request, "allow");
    },
    [sendDecision],
  );

  const currentTitle = renamedTitle ?? session.title ?? routeTitle ?? "";

  const showSessionMenu = useCallback(() => {
    void Alert.alert(
      "Session",
      undefined,
      [
        {
          text: "Rename",
          onPress: () => {
            if (!relaySupports(relayProtocol, "rename")) {
              showOutdatedAlert("rename chats");
              return;
            }
            setRenameVisible(true);
          },
        },
        { text: "Model and thinking", onPress: () => setModelSheetVisible(true) },
        {
          text: "Usage",
          onPress: () => {
            if (!relaySupports(relayProtocol, "usage")) {
              showOutdatedAlert("see usage");
              return;
            }
            setUsageSheetVisible(true);
          },
        },
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
        { text: "Cancel", style: "cancel" as const },
      ],
    );
  }, [session.running, archived, toggleArchive, stop, relayProtocol]);

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
          {chatSettings.thoughtLevel ? ` · ${thinkingLabel(chatSettings.thoughtLevel)}` : ""}
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

      {attachments.length > 0 ? (
        <AttachmentTray
          items={attachments}
          onRemove={(key) =>
            setAttachments((current) => current.filter((item) => item.key !== key))
          }
          onRetry={(key) => {
            const item = attachments.find((entry) => entry.key === key);
            if (item) void uploadAttachment(item);
          }}
        />
      ) : undefined}
      {barRequest ? (
        <View style={[styles.approvalBar, { backgroundColor: t.colors.muted }]}>
          <Pressable
            onPress={() => setApprovalOpen(true)}
            accessibilityRole="button"
            accessibilityLabel={`Permission request: ${barRequest.summary}. Open details`}
            style={styles.approvalBarText}
            hitSlop={4}
          >
            <Text variant="caption" numberOfLines={1} style={styles.flex}>
              {barRequest.summary}
            </Text>
            <Text variant="caption" color="subtext">
              Details
            </Text>
          </Pressable>
          {approvalNote ? (
            <Text variant="caption" color="subtext" numberOfLines={1}>
              {approvalNote}
            </Text>
          ) : (
            <View style={styles.approvalBarActions}>
              <Pill
                label="Allow once"
                onPress={() => allowRequest(barRequest)}
                disabled={Boolean(approvalBusy)}
                style={styles.approvalPill}
                accessibilityLabel="Allow once"
              />
              <Pill
                label="Deny"
                variant="quiet"
                onPress={() => void sendDecision(barRequest, "deny")}
                disabled={Boolean(approvalBusy)}
                style={styles.approvalPill}
                accessibilityLabel="Deny this request"
              />
            </View>
          )}
        </View>
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
          canSend={
            (draft.trim().length > 0 ||
              attachments.some((item) => item.state === "ready" && item.ref)) &&
            !sending
          }
          sendDisabled={attachments.some((item) => item.state !== "ready")}
          autoFocus={autoFocusComposer}
          onAddPress={showAddSheet}
          modeLabel={chatSettings.mode ? permissionLabel(chatSettings.mode) : null}
          onPermissionPress={openPermissionSheet}
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
      <PermissionSheet
        visible={permissionVisible}
        onClose={() => setPermissionVisible(false)}
        running={session.running}
        mode={chatSettings.mode}
        onPick={(mode: PhoneMode) => void applyMode(mode)}
      />
      <ApprovalSheet
        visible={approvalOpen && Boolean(barRequest)}
        title={barRequest?.risky ? "Allow this command?" : "Permission request"}
        folder={currentTitle}
        toolName={barRequest?.toolName ?? ""}
        target={barRequest?.detail ?? ""}
        reason=""
        confirmDetail={barRequest?.risky ? barRequest.detail : undefined}
        onAllow={() => {
          setApprovalOpen(false);
          if (barRequest) void sendDecision(barRequest, "allow");
        }}
        onDeny={() => {
          setApprovalOpen(false);
          if (barRequest) void sendDecision(barRequest, "deny");
        }}
        answeredElsewhere={
          approvalOpen &&
          Boolean(barRequest) &&
          !approvalRequests.some((request) => request.key === barRequest?.key)
        }
        onDismiss={() => setApprovalOpen(false)}
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
      <UserBubble item={item} />
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

const UserBubble = React.memo(function UserBubble({ item }: { item: ChatItem }) {
  const t = useTheme();
  return (
    <View style={styles.userRow}>
      <View style={[styles.bubble, { backgroundColor: t.colors.muted }]}>
        {item.attachments && item.attachments.length > 0 ? (
          <View style={styles.attachmentRow}>
            {item.attachments.map((attachment, index) => (
              <View
                key={`${item.key}-${index}`}
                style={[styles.attachmentChip, { backgroundColor: t.colors.surface }]}
              >
                {attachment.localUri ? (
                  <Image
                    source={{ uri: attachment.localUri }}
                    style={styles.attachmentThumb}
                  />
                ) : (
                  <Feather
                    name={attachment.image ? "image" : "file-text"}
                    size={14}
                    color={t.colors.subtext}
                  />
                )}
                <Text
                  numberOfLines={1}
                  style={[styles.attachmentLabel, { color: t.colors.subtext }]}
                >
                  {attachment.image
                    ? formatBytes(attachment.sizeBytes)
                    : attachment.label}
                </Text>
                <Text
                  numberOfLines={1}
                  style={[styles.attachmentLabel, { color: t.colors.subtext }]}
                >
                  {formatBytes(attachment.sizeBytes)}
                </Text>
              </View>
            ))}
          </View>
        ) : undefined}
        <Text variant="body" selectable>
          {item.text}
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
  approvalBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginHorizontal: 20,
    marginBottom: 6,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  approvalBarText: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    minHeight: 32,
  },
  approvalBarActions: { flexDirection: "row", gap: 8 },
  approvalPill: { minHeight: 44, paddingHorizontal: 16 },
  userRow: { flexDirection: "row", justifyContent: "flex-end", marginVertical: 4 },
  bubble: {
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 10,
    maxWidth: "85%",
    marginVertical: 4,
  },
  attachmentRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 6 },
  attachmentChip: {
    width: 64,
    borderRadius: 10,
    padding: 6,
    alignItems: "center",
    gap: 3,
  },
  attachmentThumb: { width: 50, height: 38, borderRadius: 6 },
  attachmentLabel: { fontSize: 8.5, lineHeight: 10 },
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
