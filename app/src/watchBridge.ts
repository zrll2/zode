// Watch bridge (W1 spike): the watch says hello over WatchConnectivity and
// the phone answers with a snapshot of the relay. The pure part
// (buildWatchSnapshot) is unit-tested; the hook is guarded everywhere so a
// missing watch, Expo Go, Android, or demo mode can never crash the app.

import { useEffect, useRef } from "react";
import { Platform } from "react-native";
import { useRelay } from "./useRelay";
import { projectName } from "./sessionStatus";
import { parseSessionList, type SessionRow } from "./util";

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
    .sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state] || b.updatedAt - a.updatedAt)
    .slice(0, MAX_SESSIONS)
    .map(({ updatedAt: _updatedAt, ...row }) => row);
  const servers =
    typeof input.servers === "number" && Number.isFinite(input.servers) && input.servers > 0
      ? Math.floor(input.servers)
      : 0;
  return { ok: true, status: input.status, servers, sessions };
}

interface WatchModule {
  sendMessage(
    message: Record<string, unknown>,
    replyCb?: (reply: Record<string, unknown>) => void,
    errCb?: (error: Error) => void,
  ): void;
  updateApplicationContext(context: Record<string, unknown>): void;
  getIsPaired?: () => Promise<boolean>;
  watchEvents: {
    addListener(
      event: "message",
      cb: (
        payload: Record<string, unknown>,
        reply: ((resp: Record<string, unknown>) => void) | null,
      ) => void,
    ): () => void;
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
export function useWatchBridge(): void {
  const { status, servers, rpc, client } = useRelay();

  const rowsRef = useRef<SessionRow[]>([]);
  const pairedRef = useRef(false);
  const lastPushRef = useRef(0);
  const lastFetchRef = useRef(0);
  const pushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const live = useRef({ status, servers: servers.length, rpc });
  live.current = { status, servers: servers.length, rpc };

  useEffect(() => {
    if (Platform.OS !== "ios") return undefined;
    const watch = loadWatchModule();
    if (!watch) return undefined;

    let cancelled = false;
    const unsubs: (() => void)[] = [];

    const snapshot = () =>
      buildWatchSnapshot({
        sessions: rowsRef.current,
        status: live.current.status,
        servers: live.current.servers,
      });

    const pushNow = () => {
      lastPushRef.current = Date.now();
      try {
        watch.updateApplicationContext(snapshot());
      } catch {}
    };

    // At most one push per 2 s.
    const schedulePush = () => {
      if (pushTimerRef.current) return;
      const wait = Math.max(0, PUSH_THROTTLE_MS - (Date.now() - lastPushRef.current));
      pushTimerRef.current = setTimeout(() => {
        pushTimerRef.current = null;
        if (cancelled) return;
        pushNow();
      }, wait);
    };

    // The session list comes from the same rpc the home list uses.
    const fetchSessions = (force: boolean) => {
      const now = Date.now();
      if (!force && now - lastFetchRef.current < REFETCH_THROTTLE_MS) return;
      lastFetchRef.current = now;
      void (async () => {
        try {
          const rows = parseSessionList(await live.current.rpc("session/list", {}));
          if (cancelled) return;
          rowsRef.current = rows;
          schedulePush();
        } catch {}
      })();
    };

    void (async () => {
      try {
        const paired = (await watch.getIsPaired?.()) ?? false;
        if (!cancelled) pairedRef.current = paired;
      } catch {}
    })();

    try {
      unsubs.push(
        watch.watchEvents.addListener("message", (payload, reply) => {
          try {
            if (!payload || payload.type !== "hello") return;
            const value = snapshot();
            if (reply) reply(value);
            pairedRef.current = true;
            pushNow();
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

    unsubs.push(
      client?.onEvent(() => {
        // relay activity usually means the list changed; refetch, throttled
        if (live.current.status === "ready") fetchSessions(false);
      }) ?? (() => {}),
    );
    if (status === "ready") fetchSessions(true);

    return () => {
      cancelled = true;
      if (pushTimerRef.current) {
        clearTimeout(pushTimerRef.current);
        pushTimerRef.current = null;
      }
      for (const unsubscribe of unsubs) {
        try {
          unsubscribe();
        } catch {}
      }
    };
    // `status` re-runs the setup so a fresh connection fetches immediately.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, client]);

  // Keep the snapshot fresh on connection changes too (the push reads
  // live.current at fire time, so this only needs to schedule).
  useEffect(() => {
    if (Platform.OS !== "ios") return;
    if (!pairedRef.current) return;
    const watch = loadWatchModule();
    if (!watch) return;
    const wait = Math.max(0, PUSH_THROTTLE_MS - (Date.now() - lastPushRef.current));
    const timer = setTimeout(() => {
      try {
        watch.updateApplicationContext(
          buildWatchSnapshot({
            sessions: rowsRef.current,
            status,
            servers: servers.length,
          }),
        );
        lastPushRef.current = Date.now();
      } catch {}
    }, wait);
    return () => clearTimeout(timer);
  }, [status, servers]);
}
