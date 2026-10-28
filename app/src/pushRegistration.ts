// Push registration (PS3): permission -> APNs token -> push service ->
// relay. The flow is a plain async function with injectable dependencies so
// the tests never touch a native module; `usePushRegistration` is the thin
// glue mounted on the home screen.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Platform } from "react-native";
import * as Notifications from "expo-notifications";
import { PUSH_SERVICE_URL, BUNDLE_ID } from "./config";
import { loadPrefs, savePrefs } from "./storage";
import { useRelay } from "./useRelay";

export type PushState = "enabled" | "off" | "denied" | "unavailable";

export interface PushNotificationsApi {
  requestPermissionsAsync(): Promise<{ granted: boolean }>;
  getDevicePushTokenAsync(): Promise<{ type: string; data: string }>;
  addPushTokenListener(
    listener: (token: { type: string; data: string }) => void,
  ): { remove(): void };
}

export interface PushRegistrationDeps {
  notifications?: PushNotificationsApi;
  fetchImpl?: typeof fetch;
  rpc?: (method: string, params?: unknown) => Promise<unknown>;
  pushKey?: string;
  pushId?: string;
  env?: "sandbox" | "production";
  bundleId?: string;
  serviceUrl?: string;
  loadPrefs?: () => Promise<{ pushEnabled: boolean }>;
  savePushEnabled?: (enabled: boolean) => Promise<void>;
  // Persists the registration slot; null clears it (prefs.pushId).
  savePushId?: (pushId: string | null) => Promise<void>;
}

function defaultNotifications(): PushNotificationsApi {
  return Notifications as unknown as PushNotificationsApi;
}

function env(deps: PushRegistrationDeps): "sandbox" | "production" {
  return deps.env ?? (typeof __DEV__ === "boolean" && __DEV__ ? "sandbox" : "production");
}

// Permission -> APNs token -> POST /api/register -> relay `push/register`.
// Never throws; the returned state is what the menu row shows.
export async function registerPush(deps: PushRegistrationDeps = {}): Promise<PushState> {
  if (!deps.pushKey) return "unavailable";
  const notifications = deps.notifications ?? defaultNotifications();
  try {
    const permission = await notifications.requestPermissionsAsync();
    if (!permission?.granted) return "denied";

    const token = await notifications.getDevicePushTokenAsync();
    if (!token?.data) return "off";

    const response = await (deps.fetchImpl ?? fetch)(
      `${deps.serviceUrl ?? PUSH_SERVICE_URL}/api/register`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          deviceToken: token.data,
          env: env(deps),
          bundleId: deps.bundleId ?? BUNDLE_ID,
        }),
      },
    );
    if (!response.ok) return "off";
    const registered = (await response.json()) as { pushId?: unknown; secret?: unknown };
    if (typeof registered?.pushId !== "string" || typeof registered?.secret !== "string") {
      return "off";
    }

    const rpc = deps.rpc;
    if (!rpc) return "off";
    await rpc("push/register", {
      pushId: registered.pushId,
      secret: registered.secret,
      env: env(deps),
    });

    // Remember the slot so turning push off later can unregister it.
    try {
      await (deps.savePushId ?? savePushIdDefault)(registered.pushId);
    } catch {}

    return "enabled";
  } catch {
    return "off";
  }
}

// App start / token change: re-register only when the user turned push on.
// Cheap and idempotent on the relay and the push service.
export async function ensurePushOnStart(
  deps: PushRegistrationDeps = {},
): Promise<PushState | null> {
  const load = deps.loadPrefs ?? loadPrefs;
  try {
    const prefs = await load();
    if (!prefs.pushEnabled) return null;
  } catch {
    return null;
  }
  return registerPush(deps);
}

// The user's explicit turn-on from the menu row or the first-run sheet:
// register and remember the choice.
export async function enablePush(deps: PushRegistrationDeps = {}): Promise<PushState> {
  const state = await registerPush(deps);
  const save = deps.savePushEnabled ?? savePushEnabledDefault;
  try {
    await save(state === "enabled");
  } catch {}
  return state;
}

// Best-effort relay unregister + forget. Never throws.
export async function disablePush(deps: PushRegistrationDeps = {}): Promise<void> {
  try {
    if (deps.pushId) await deps.rpc?.("push/unregister", { pushId: deps.pushId });
  } catch {}
  const save = deps.savePushEnabled ?? savePushEnabledDefault;
  try {
    await save(false);
  } catch {}
  try {
    await (deps.savePushId ?? savePushIdDefault)(null);
  } catch {}
}

async function savePushEnabledDefault(enabled: boolean): Promise<void> {
  const prefs = await loadPrefs();
  await savePrefs({ ...prefs, pushEnabled: enabled });
}

async function savePushIdDefault(pushId: string | null): Promise<void> {
  const prefs = await loadPrefs();
  await savePrefs({ ...prefs, pushId });
}

export function pushRowLabel(state: PushState): string {
  switch (state) {
    case "enabled":
      return "Notifications: On";
    case "denied":
      return "Notifications: Denied";
    case "unavailable":
      return "Notifications: Pair again";
    default:
      return "Notifications: Off";
  }
}

// Hook glue (untested): mirrors the relay/prefs state and keeps the menu row
// up to date. Registration only runs on iOS once the relay is ready and the
// relay announced `features.push`.
export function usePushRegistration(): {
  pushState: PushState;
  enableFromMenu: () => void;
  disableFromMenu: () => void;
} {
  const { status, rpc, credentials, relayFeatures } = useRelay();
  const [pushState, setPushState] = useState<PushState>("off");

  const pushKey = credentials?.pushKey;
  const pushFeature = relayFeatures.push === true;
  const state = useRef({ status, rpc, pushKey, pushFeature });
  state.current = { status, rpc, pushKey, pushFeature };

  const runRegistration = useCallback(async () => {
    const current = state.current;
    const next = await registerPush({
      rpc: current.rpc as (method: string, params?: unknown) => Promise<unknown>,
      pushKey: current.pushKey,
    });
    setPushState(next);
  }, []);

  // App start: re-register when enabled (cheap, idempotent).
  useEffect(() => {
    if (Platform.OS !== "ios") return;
    void (async () => {
      try {
        const prefs = await loadPrefs();
        if (!prefs.pushEnabled) return;
        const current = state.current;
        if (current.status !== "ready" || !current.pushFeature) return;
        if (!current.pushKey) {
          setPushState("unavailable");
          return;
        }
        const next = await registerPush({
          rpc: current.rpc as (method: string, params?: unknown) => Promise<unknown>,
          pushKey: current.pushKey,
        });
        setPushState(next);
      } catch {}
    })();
    // runs once on mount; later re-registers ride the status effect below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // After the relay connects: re-register when enabled.
  useEffect(() => {
    if (Platform.OS !== "ios") return;
    if (status !== "ready") return;
    void (async () => {
      try {
        const prefs = await loadPrefs();
        if (!prefs.pushEnabled) return;
        const current = state.current;
        if (!current.pushFeature) return;
        if (!current.pushKey) {
          setPushState("unavailable");
          return;
        }
        const next = await registerPush({
          rpc: current.rpc as (method: string, params?: unknown) => Promise<unknown>,
          pushKey: current.pushKey,
        });
        setPushState(next);
      } catch {}
    })();
  }, [status]);

  // APNs token changes: re-register when enabled.
  useEffect(() => {
    if (Platform.OS !== "ios") return;
    const notifications = defaultNotifications();
    const subscription = notifications.addPushTokenListener(() => {
      void (async () => {
        try {
          const prefs = await loadPrefs();
          if (!prefs.pushEnabled) return;
          await runRegistration();
        } catch {}
      })();
    });
    return () => subscription.remove();
  }, [runRegistration]);

  const enableFromMenu = useCallback(() => {
    const current = state.current;
    if (!current.pushKey) {
      setPushState("unavailable");
      return;
    }
    void (async () => {
      const next = await enablePush({
        rpc: current.rpc as (method: string, params?: unknown) => Promise<unknown>,
        pushKey: current.pushKey,
      });
      setPushState(next);
    })();
  }, []);

  const disableFromMenu = useCallback(() => {
    void (async () => {
      try {
        const prefs = await loadPrefs();
        await disablePush({ pushId: prefs.pushId ?? undefined });
      } catch {}
      setPushState("off");
    })();
  }, []);

  return { pushState, enableFromMenu, disableFromMenu };
}
