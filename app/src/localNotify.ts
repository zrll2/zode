// Local notifications for task completion while the app is alive but backgrounded. This is the fallback that
// works today, before the push service (PS1) is deployed; remote push replaces it for a killed app. Pure
// decision function is tested, the hook is glue (repo convention).

import { useEffect, useRef } from "react";
import { AppState } from "react-native";
import * as Notifications from "expo-notifications";
import { useRelay } from "./useRelay";
import { loadPrefs } from "./storage";
import { initialSessionState, reduce, type SessionState } from "./relay/reducer";
import type { RelayMessage } from "./relay/protocol";

export interface LocalNotifyHit {
  title: string;
  body: string;
  sound: boolean;
}

export interface LocalNotifyContext {
  appState: string | null | undefined; // AppState.currentState at the time of the event
}

// True only when remote push fully covers this device: the user opted in, a
// push slot was registered, and the relay announced `features.push`. When
// this is true the local banners below would duplicate the APNs banner.
export function remotePushActive(input: {
  pushEnabled: boolean;
  pushId: string | null | undefined;
  relayPush: boolean;
}): boolean {
  return (
    input.pushEnabled === true &&
    typeof input.pushId === "string" &&
    input.pushId.length > 0 &&
    input.relayPush === true
  );
}

// What to show for one session's state transition. Only fires when the app is not in the foreground —
// on screen the user sees the chat update live, and a banner there is noise.
export function localNotifyFor(
  prev: SessionState,
  next: SessionState,
  ctx: LocalNotifyContext,
): LocalNotifyHit | null {
  if (ctx.appState === "active") return null;
  const title = next.title ?? "ZCode";
  if (prev.running && !next.running) {
    const body = next.lastResponse?.replace(/\s+/g, " ").trim().slice(0, 120) || "Task finished";
    return { title, body, sound: false };
  }
  if (!prev.permissionRequest && next.permissionRequest) {
    const tool = next.permissionRequest.toolName;
    return { title, body: tool ? `Wants to use ${tool}` : "Needs your approval", sound: true };
  }
  return null;
}

// Subscribes once near the root; reduces every subscribed session's stream and schedules a local
// notification on the transitions above — unless remote push covers this
// device (then the APNs banner already carries the news). Never throws; caps its memory.
export function useLocalTaskNotifications(): void {
  const { client } = useRelay();
  const states = useRef(new Map<string, SessionState>());
  const seen = useRef(new Set<string>());
  // Read on mount and on every AppState change (backgrounded, foregrounded,
  // ...) so the local-vs-remote decision is fresh whenever a banner becomes
  // possible. No polling, no per-event reads.
  const remoteRef = useRef({ pushEnabled: false, pushId: null as string | null });

  useEffect(() => {
    const reread = () => {
      void loadPrefs()
        .then((prefs) => {
          remoteRef.current = { pushEnabled: prefs.pushEnabled, pushId: prefs.pushId };
        })
        .catch(() => {});
    };
    reread();
    const subscription = AppState.addEventListener("change", reread);
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (!client) return;
    const off = client.onEvent((msg: RelayMessage) => {
      try {
        const params = (msg.params ?? {}) as Record<string, unknown>;
        const sid = typeof params.sessionId === "string" ? params.sessionId : null;
        if (!sid) return;
        const prev = states.current.get(sid) ?? initialSessionState(sid);
        const next = reduce(prev, msg);
        states.current.set(sid, next);
        if (states.current.size > 200) {
          const oldest = states.current.keys().next().value;
          if (typeof oldest === "string") states.current.delete(oldest);
        }
        if (
          remotePushActive({
            pushEnabled: remoteRef.current.pushEnabled,
            pushId: remoteRef.current.pushId,
            relayPush: client.relayFeatures.push === true,
          })
        ) {
          return;
        }
        const hit = localNotifyFor(prev, next, { appState: AppState.currentState });
        if (!hit) return;
        const key = `${sid}:${next.items.length}:${next.running ? "r" : "i"}`;
        if (seen.current.has(key)) return;
        seen.current.add(key);
        if (seen.current.size > 300) {
          const oldest = seen.current.values().next().value;
          if (oldest !== undefined) seen.current.delete(oldest);
        }
        void Notifications.scheduleNotificationAsync({
          content: { title: hit.title, body: hit.body, sound: hit.sound ? true : undefined },
          trigger: null,
        }).catch(() => {});
      } catch {}
    });
    return off;
  }, [client]);
}
