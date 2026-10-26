// Watch-style push action handling (PS3): Allow / Deny answer the sealed
// permission request over a short-lived relay connection; Reply sends the
// typed text as a prompt. Injectable connect/notifications so the tests
// never touch a native module or a real socket.

import { Linking } from "react-native";
import * as Notifications from "expo-notifications";
import * as TaskManager from "expo-task-manager";
import { RelayClient } from "./relay/client";

// The slice of the relay client the actions use: a narrow type so fakes fit in tests.
export type PushRelay = Pick<RelayClient, "connect" | "respond" | "rpc" | "close">;
import { loadCredentials, type Credentials } from "./storage";
import { buildSessionSendParams } from "./relay/params";
import { openSealed, parseNotificationData, type SealedPayload } from "./push";

export const PUSH_ACTION_TASK = "zode.push.action";

const CONNECT_TIMEOUT_MS = 10_000;
const ANSWER_TIMEOUT_MS = 8_000;
const DEFAULT_ACTION = "expo.modules.notifications.actions.DEFAULT";

interface PushResponseLike {
  actionIdentifier: string;
  userText?: string;
  notification: {
    request: {
      identifier: string;
      content: { data?: Record<string, unknown> };
    };
  };
}

export interface PushActionNotifications {
  scheduleNotificationAsync(content: {
    content: { title: string; body: string };
    trigger: null;
  }): Promise<string>;
}

export interface PushActionDeps {
  // Builds the short-lived relay connection. Defaults to the real RelayClient
  // with the stored credentials' addresses and token.
  connect?: (creds: Credentials) => PushRelay;
  loadCredentials?: () => Promise<Credentials | null>;
  notifications?: PushActionNotifications;
  openConversation?: (sessionId: string | null) => void;
}

const defaultNotifications = (): PushActionNotifications =>
  Notifications as unknown as PushActionNotifications;

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

// One action in flight per notification id.
const inFlight = new Set<string>();

export async function runPushAction(
  response: PushResponseLike,
  deps: PushActionDeps = {},
): Promise<void> {
  let notificationId: string | null = null;
  try {
    const data = parseNotificationData(response?.notification?.request?.content?.data);
    if (!data) return;
    notificationId = response.notification?.request?.identifier ?? null;
    // Registered synchronously so a second tap cannot double-send.
    if (notificationId && inFlight.has(notificationId)) return;
    if (notificationId) inFlight.add(notificationId);

    const creds = await (deps.loadCredentials ?? loadCredentials)();
    if (!creds?.pushKey) return;
    const payload = openSealed(creds.pushKey, data.kind, data.sealed);
    if (!payload) return;

    switch (response.actionIdentifier) {
      case "allow":
      case "deny": {
        if (!payload.req) return;
        const outcome = await withRelay(creds, deps, (client) =>
          withTimeout(
            client.respond(
              payload.req!.server,
              payload.req!.id,
              response.actionIdentifier as "allow" | "deny",
            ),
            ANSWER_TIMEOUT_MS,
            "answer timed out",
          ),
        );
        if (!outcome) showFailure(deps);
        return;
      }
      case "reply": {
        const text = response.userText?.trim();
        if (!text || !payload.session) return;
        const outcome = await withRelay(creds, deps, (client) =>
          withTimeout(
            client.rpc(
              "session/send",
              buildSessionSendParams(payload.session as string, text),
            ),
            ANSWER_TIMEOUT_MS,
            "send timed out",
          ),
        );
        if (!outcome) showFailure(deps);
        return;
      }
      default:
        if (response.actionIdentifier === DEFAULT_ACTION) {
          deps.openConversation?.(payload.session ?? null);
        }
        return;
    }
  } catch {
    showFailure(deps);
  } finally {
    if (notificationId) inFlight.delete(notificationId);
  }
}

// Opens a short-lived relay connection (the client races the stored
// addresses), waits for ready, runs the action, closes.
async function withRelay<T>(
  creds: Credentials,
  deps: PushActionDeps,
  run: (client: PushRelay) => Promise<T>,
): Promise<T | null> {
  let client: PushRelay;
  try {
    client =
      deps.connect?.(creds) ??
      new RelayClient({ url: creds.wsUrl, urls: creds.wsUrls, token: creds.token });
  } catch {
    return null;
  }
  try {
    await withTimeout(client.connect(), CONNECT_TIMEOUT_MS, "connect timed out");
    return await run(client);
  } catch {
    return null;
  } finally {
    client.close();
  }
}

function showFailure(deps: PushActionDeps) {
  const notifications = deps.notifications ?? defaultNotifications();
  void notifications
    .scheduleNotificationAsync({
      content: { title: "Zode", body: "Could not reach your Mac" },
      trigger: null,
    })
    .catch(() => {});
}

function routeDefault(response: PushResponseLike, deps: PushActionDeps) {
  try {
    if (response.actionIdentifier !== DEFAULT_ACTION) return;
    const data = parseNotificationData(response.notification?.request?.content?.data);
    if (!data) return;
    void (async () => {
      try {
        const stored = await (deps.loadCredentials ?? loadCredentials)();
        if (!stored?.pushKey) return;
        const payload: SealedPayload | null = openSealed(stored.pushKey, data.kind, data.sealed);
        if (!payload) return;
        deps.openConversation?.(payload.session ?? null);
      } catch {}
    })();
  } catch {}
}

// Registers everything once from the root layout: the foreground handler
// (banners while open, no sound for `done`), the in-app response listener and
// the background task.
export function registerPushTasks(deps: PushActionDeps = {}): void {
  try {
    Notifications.setNotificationHandler({
      handleNotification: async (notification) => {
        const kind = (notification.request.content.data as Record<string, unknown> | undefined)?.k;
        return {
          shouldShowAlert: true,
          shouldShowBanner: true,
          shouldShowList: true,
          shouldPlaySound: kind !== "done",
          shouldSetBadge: false,
        };
      },
    });
  } catch {}
  try {
    Notifications.addNotificationResponseReceivedListener((response) => {
      routeDefault(response as PushResponseLike, deps);
      void runPushAction(response as PushResponseLike, deps);
    });
  } catch {}
  try {
    TaskManager.defineTask(PUSH_ACTION_TASK, async (taskBody: unknown) => {
      try {
        const response = (taskBody as { data?: PushResponseLike })?.data;
        if (response) void runPushAction(response, deps);
      } catch {}
    });
    void Notifications.registerTaskAsync(PUSH_ACTION_TASK).catch(() => {});
  } catch {}
}

interface CategoryNotifications {
  setNotificationCategoryAsync(identifier: string, actions: unknown[]): Promise<unknown>;
}

// One-shot registration of the action categories (zode.<kind>); the service
// sets `aps.category` to the same identifiers.
export async function ensureNotificationCategories(
  notifications: CategoryNotifications = Notifications as unknown as CategoryNotifications,
): Promise<void> {
  const reply = {
    identifier: "reply",
    buttonTitle: "Send",
    textInput: { submitButtonTitle: "Send", placeholder: "Message" },
    options: { opensAppToForeground: false },
  };
  const allow = {
    identifier: "allow",
    buttonTitle: "Allow",
    options: { opensAppToForeground: false },
  };
  const deny = {
    identifier: "deny",
    buttonTitle: "Deny",
    options: { opensAppToForeground: false },
  };
  try {
    await notifications.setNotificationCategoryAsync("zode.ask", [allow, deny]);
    await notifications.setNotificationCategoryAsync("zode.question", [reply]);
    await notifications.setNotificationCategoryAsync("zode.failed", [reply]);
    await notifications.setNotificationCategoryAsync("zode.stuck", [reply]);
    await notifications.setNotificationCategoryAsync("zode.done", [reply]);
  } catch {}
}

// Tapping a notification body opens the conversation (or the list) through
// the app's own scheme.
export function openConversationDeepLink(sessionId: string | null): void {
  const url = sessionId ? `zode://session/${sessionId}` : "zode://sessions";
  void Linking.openURL(url).catch(() => {});
}
