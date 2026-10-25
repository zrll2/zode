// Watch bridge (W1+W2): the watch says hello, records clips and composes
// prompts; the phone transcribes/sends them and answers. The pure parts are
// unit-tested (buildWatchSnapshot here, the rest in watchVoice.ts); the hook
// is guarded everywhere so a missing watch, Expo Go, Android, or demo mode
// can never crash the app.

import { useCallback, useEffect, useRef } from "react";
import { Platform } from "react-native";
import { File } from "expo-file-system";
import { useRelay } from "./useRelay";
import { projectName } from "./sessionStatus";
import { parseSessionList, type SessionRow } from "./util";
import { buildSessionSendParams } from "./relay/params";
import { buildVoiceHint, transcribeClip, voiceErrorText } from "./voice";
import {
  buildPromptReply,
  buildTranscriptReply,
  parseWatchAudio,
  parseWatchPrompt,
  pickDefaultSession,
  phoneUnreachableText,
  promptFailureText,
  voiceUnavailableText,
  type TranscriptReply,
} from "./watchVoice";

export type WatchRowState = "needs" | "working" | "idle";

export interface WatchRow {
  id: string;
  project: string;
  title: string;
  state: WatchRowState;
}

export type WatchSnapshot = {
  ok: true;
  status: string;
  servers: number;
  sessions: WatchRow[];
  // First needs-you row, else the most recent — the watch preselects it.
  defaultSessionId: string | null;
};

const MAX_SESSIONS = 8;
const PUSH_THROTTLE_MS = 2_000;
const REFETCH_THROTTLE_MS = 10_000;

const STATE_RANK: Record<WatchRowState, number> = { needs: 0, working: 1, idle: 2 };

function stateOf(row: SessionRow): WatchRowState {
  if (row.status === "waiting" || row.status === "error") return "needs";
  if (row.status === "running") return "working";
  return "idle";
}

// Needs-you first, then most recent; capped at 8; junk rows ignored.
export function buildWatchSnapshot(input: {
  sessions: unknown;
  status: string;
  servers: number;
}): WatchSnapshot {
  const rows = Array.isArray(input.sessions) ? input.sessions : [];
  const cleaned: SessionRow[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const candidate = row as Partial<SessionRow>;
    if (typeof candidate.id !== "string" || !candidate.id) continue;
    cleaned.push({
      id: candidate.id,
      title: typeof candidate.title === "string" ? candidate.title : "",
      folder: typeof candidate.folder === "string" ? candidate.folder : "",
      status: typeof candidate.status === "string" ? candidate.status : "idle",
      updatedAt: typeof candidate.updatedAt === "number" ? candidate.updatedAt : null,
    });
  }
  const sessions = cleaned
    .map((row) => {
      const project = projectName(row.folder);
      return {
        id: row.id,
        project,
        title: row.title.trim() || project,
        state: stateOf(row),
        updatedAt: row.updatedAt ?? 0,
      };
    })
    .sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state] || b.updatedAt - a.updatedAt);
  const visible = sessions.slice(0, MAX_SESSIONS).map(({ updatedAt: _updatedAt, ...row }) => row);
  const servers =
    typeof input.servers === "number" && Number.isFinite(input.servers) && input.servers > 0
      ? Math.floor(input.servers)
      : 0;
  return {
    ok: true,
    status: input.status,
    servers,
    sessions: visible,
    defaultSessionId: pickDefaultSession(sessions)?.id ?? null,
  };
}

// Pure fetch/push decisions (W4): exported so the demo sequence
// (status connecting -> ready, rpc resolving late, re-renders in between)
// can be regression-tested without rendering the hook.
export function shouldFetch(input: {
  status: string;
  hasRows: boolean;
  force: boolean;
  lastFetchMs: number;
  nowMs: number;
  throttleMs: number;
}): boolean {
  if (input.status !== "ready") return false;
  if (input.force) return true;
  // An empty list is worth retrying sooner than the throttle window.
  if (!input.hasRows) return true;
  return input.nowMs - input.lastFetchMs >= input.throttleMs;
}

export function nextPushDelayMs(lastPushMs: number, nowMs: number, throttleMs: number): number {
  return Math.max(0, throttleMs - (nowMs - lastPushMs));
}

interface WatchReceivedFile {
  id: string;
  metadata?: unknown;
  url: string;
}

interface WatchModule {
  sendMessage(
    message: Record<string, unknown>,
    replyCb?: (reply: Record<string, unknown>) => void,
    errCb?: (error: Error) => void,
  ): void;
  updateApplicationContext(context: Record<string, unknown>): void;
  getIsPaired?: () => Promise<boolean>;
  sendUserInfo?: (payload: Record<string, unknown>) => void;
  watchEvents: {
    addListener(
      event: "message",
      cb: (
        payload: Record<string, unknown>,
        reply: ((resp: Record<string, unknown>) => void) | null,
      ) => void,
    ): () => void;
    addListener(event: "file-received", cb: (files: WatchReceivedFile[]) => void): () => void;
    addListener(event: "reachability", cb: (reachable: boolean) => void): () => void;
    addListener(event: "paired", cb: (paired: boolean) => void): () => void;
  };
}

// Loaded lazily and defensively: Android and Expo Go never touch the native
// module this way.
function loadWatchModule(): WatchModule | null {
  if (Platform.OS !== "ios") return null;
  try {
    const mod = require("react-native-watch-connectivity") as Partial<WatchModule>;
    if (
      !mod ||
      typeof mod.sendMessage !== "function" ||
      typeof mod.updateApplicationContext !== "function" ||
      !mod.watchEvents
    ) {
      return null;
    }
    return mod as WatchModule;
  } catch {
    return null;
  }
}

// Mounted once near the root (inside the relay provider). Listens for the
// watch's hello, answers with the latest snapshot, and pushes the same
// snapshot to the application context whenever the list or status changes.
//
// W4: fetch/push no longer live inside an effect run. Every effect re-run
// used to cancel the in-flight fetch (its `cancelled` flag) and clear the
// pending push timer, so a snapshot fetched on `ready` could be dropped and
// the watch stayed empty. Now rows and the latest relay state live in refs,
// the push timer belongs to the component, and every fetch — success or
// failure — ends in a (throttled) push.
export function useWatchBridge(): void {
  const { status, servers, rpc, client, relayFeatures } = useRelay();

  const rowsRef = useRef<SessionRow[]>([]);
  const pairedRef = useRef(false);
  const lastPushRef = useRef(0);
  const lastFetchRef = useRef(0);
  const pushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const state = useRef({ status, servers: servers.length, rpc, stt: relayFeatures.stt });
  state.current = { status, servers: servers.length, rpc, stt: relayFeatures.stt };

  const snapshot = useCallback(
    () =>
      buildWatchSnapshot({
        sessions: rowsRef.current,
        status: state.current.status,
        servers: state.current.servers,
      }),
    [],
  );

  const pushNow = useCallback(() => {
    lastPushRef.current = Date.now();
    const watch = loadWatchModule();
    if (!watch) return;
    try {
      watch.updateApplicationContext(snapshot());
    } catch {}
  }, [snapshot]);

  // At most one push per 2 s, no matter which source asked for it.
  const schedulePush = useCallback(() => {
    if (pushTimerRef.current) return;
    const wait = nextPushDelayMs(lastPushRef.current, Date.now(), PUSH_THROTTLE_MS);
    pushTimerRef.current = setTimeout(() => {
      pushTimerRef.current = null;
      pushNow();
    }, wait);
  }, [pushNow]);

  const fetchSessions = useCallback(
    (force: boolean) => {
      const now = Date.now();
      if (
        !shouldFetch({
          status: state.current.status,
          hasRows: rowsRef.current.length > 0,
          force,
          lastFetchMs: lastFetchRef.current,
          nowMs: now,
          throttleMs: REFETCH_THROTTLE_MS,
        })
      ) {
        return;
      }
      lastFetchRef.current = now;
      void (async () => {
        try {
          const rows = parseSessionList(await state.current.rpc("session/list", {}));
          rowsRef.current = rows;
        } catch {
          // keep the rows we have; the push still carries the status change
        }
        schedulePush();
      })();
    },
    [schedulePush],
  );

  // Replies ride on sendMessage when the watch is reachable, else on user
  // info (delivered whenever the watch next checks in).
  const replyToWatch = useCallback((payload: Record<string, unknown>) => {
    const watch = loadWatchModule();
    if (!watch) return;
    try {
      watch.sendMessage(payload, undefined, () => {
        try {
          watch.sendUserInfo?.(payload);
        } catch {}
      });
    } catch {
      try {
        watch.sendUserInfo?.(payload);
      } catch {}
    }
  }, []);

  const voiceHint = useCallback(() => {
    try {
      return buildVoiceHint(rowsRef.current);
    } catch {
      return undefined;
    }
  }, []);

  // watch -> phone `prompt { id, sessionId, text }`: send it through the
  // relay like the chat screen does, then answer with a `result` reply.
  const handlePrompt = useCallback(
    (payload: Record<string, unknown>) => {
      const parsed = parseWatchPrompt(payload);
      if (!parsed) return;
      const { id, sessionId, text } = parsed;
      if (state.current.status !== "ready") {
        replyToWatch(buildPromptReply(id, false, phoneUnreachableText()));
        return;
      }
      void (async () => {
        try {
          await state.current.rpc("session/send", buildSessionSendParams(sessionId, text));
          replyToWatch(buildPromptReply(id, true));
        } catch (error: unknown) {
          replyToWatch(buildPromptReply(id, false, promptFailureText(error)));
        }
      })();
    },
    [replyToWatch],
  );

  // watch -> phone `audio` (file transfer with metadata): transcribe it
  // with the same path the composer uses, then answer with a `transcript`.
  const handleAudioFile = useCallback(
    (file: WatchReceivedFile) => {
      const meta = parseWatchAudio(file.metadata);
      if (!meta) return;
      void (async () => {
        try {
          if (state.current.stt !== true || state.current.status !== "ready") {
            replyToWatch(
              buildTranscriptReply(meta.id, { ok: false, message: voiceUnavailableText() }),
            );
            return;
          }
          const clip = new File(file.url);
          if (typeof clip.size === "number" && !parseWatchAudio(meta, clip.size)) {
            replyToWatch(
              buildTranscriptReply(meta.id, {
                ok: false,
                message: voiceErrorText("too-large"),
              }),
            );
            return;
          }
          const base64 = await clip.base64();
          const result = await transcribeClip({
            rpc: state.current.rpc,
            base64,
            format: meta.format,
            hint: voiceHint(),
          });
          replyToWatch(buildTranscriptReply(meta.id, result));
        } catch {
          replyToWatch(
            buildTranscriptReply(meta.id, { ok: false, message: voiceErrorText("") }),
          );
        }
      })();
    },
    [replyToWatch, voiceHint],
  );

  // watch -> phone `audio` inside a reachable message: the clip is already
  // base64, no file read. The reply handler may only be usable for a few
  // seconds, so keep the reference and answer it exactly once whenever the
  // transcription finishes.
  const handleAudioMessage = useCallback(
    (
      payload: Record<string, unknown>,
      reply: ((resp: Record<string, unknown>) => void) | null,
    ) => {
      const meta = parseWatchAudio(payload);
      if (!meta || !meta.audioBase64) return;
      let answered = false;
      const answer = (value: TranscriptReply) => {
        if (answered) return;
        answered = true;
        try {
          reply?.(value);
        } catch {}
      };
      void (async () => {
        try {
          if (state.current.stt !== true || state.current.status !== "ready") {
            answer(
              buildTranscriptReply(meta.id, { ok: false, message: voiceUnavailableText() }),
            );
            return;
          }
          if (!meta.audioBase64) {
            answer(buildTranscriptReply(meta.id, { ok: false, message: voiceErrorText("bad-audio") }));
            return;
          }
          const result = await transcribeClip({
            rpc: state.current.rpc,
            base64: meta.audioBase64,
            format: meta.format,
            hint: voiceHint(),
          });
          answer(buildTranscriptReply(meta.id, result));
        } catch {
          answer(buildTranscriptReply(meta.id, { ok: false, message: voiceErrorText("") }));
        }
      })();
    },
    [replyToWatch, voiceHint],
  );

  // The watch asks for a snapshot. An empty list while the relay is ready
  // triggers a fetch first so the reply carries fresh rows.
  const answerHello = useCallback(
    (reply: ((resp: Record<string, unknown>) => void) | null) => {
      pairedRef.current = true;
      const finish = () => {
        try {
          reply?.(snapshot());
        } catch {}
        schedulePush();
      };
      if (rowsRef.current.length > 0 || state.current.status !== "ready") {
        finish();
        return;
      }
      void (async () => {
        try {
          const rows = parseSessionList(await state.current.rpc("session/list", {}));
          rowsRef.current = rows;
        } catch {}
        finish();
      })();
    },
    [snapshot, schedulePush],
  );

  // Subscriptions live for the whole app session; every handler is stable.
  useEffect(() => {
    if (Platform.OS !== "ios") return undefined;
    const watch = loadWatchModule();
    if (!watch) return undefined;

    const unsubs: (() => void)[] = [];
    try {
      unsubs.push(
        watch.watchEvents.addListener("message", (payload, reply) => {
          try {
            if (!payload) return;
            if (payload.type === "hello") {
              answerHello(reply);
              return;
            }
            if (payload.type === "prompt") {
              handlePrompt(payload);
              return;
            }
            if (payload.type === "audio") {
              handleAudioMessage(payload, reply);
            }
          } catch {}
        }),
      );
      unsubs.push(
        watch.watchEvents.addListener("file-received", (files) => {
          try {
            for (const file of files ?? []) handleAudioFile(file);
          } catch {}
        }),
      );
      unsubs.push(
        watch.watchEvents.addListener("paired", (paired) => {
          pairedRef.current = paired;
          if (paired) schedulePush();
        }),
      );
      unsubs.push(
        watch.watchEvents.addListener("reachability", () => {
          // the watch renders reachability itself
        }),
      );
    } catch {}
    return () => {
      for (const unsubscribe of unsubs) {
        try {
          unsubscribe();
        } catch {}
      }
    };
  }, [answerHello, handleAudioFile, handleAudioMessage, handlePrompt, schedulePush]);

  // Pairing is worth a push as soon as it is known.
  useEffect(() => {
    if (Platform.OS !== "ios") return;
    const watch = loadWatchModule();
    if (!watch) return;
    void (async () => {
      try {
        const paired = (await watch.getIsPaired?.()) ?? false;
        if (paired) {
          pairedRef.current = true;
          schedulePush();
        }
      } catch {}
    })();
  }, [schedulePush]);

  // Relay activity usually means the list changed; refetch, throttled.
  useEffect(() => {
    if (!client) return undefined;
    return (
      client.onEvent(() => {
        if (state.current.status === "ready") fetchSessions(false);
      }) ?? undefined
    );
  }, [client, fetchSessions]);

  // Status and server-count changes fetch and push. This is the exact
  // demo-mode sequence: connecting -> ready lands here with the fetch
  // resolving whenever it likes — the push is scheduled at component level
  // and cannot be dropped by a re-render in between.
  useEffect(() => {
    if (status === "ready") fetchSessions(true);
    schedulePush();
  }, [status, servers.length, fetchSessions, schedulePush]);

  // Only unmount clears the pending push.
  useEffect(
    () => () => {
      if (pushTimerRef.current) {
        clearTimeout(pushTimerRef.current);
        pushTimerRef.current = null;
      }
    },
    [],
  );
}
