import * as SecureStore from "expo-secure-store";
import { PUSH_KEYCHAIN_GROUP } from "./config";

const KEY = "zcode.relay.credentials.v1";
// Sibling record for the push key so the notification extension (separate
// order) can read it through the shared keychain access group.
const PUSH_KEY = "zode.push.key.v1";

const WS_URLS_CAP = 8;

export interface Credentials {
  wsUrl: string;
  // Every address the pairing offered (and later learned from ready). The
  // phone races them and connects over whichever works.
  wsUrls: string[];
  // The address that last delivered a ready frame; tried first.
  lastGood?: string;
  // 32-byte push key, base64url; undefined on pairings made before push
  // existed (push stays unavailable until the user pairs again).
  pushKey?: string;
  token: string;
  deviceId: string;
}

// Old records hold only wsUrl; new ones gain wsUrls/lastGood. wsUrl is
// always kept and always present in wsUrls.
function normalizeCredentials(parsed: any): Credentials | null {
  if (
    !parsed ||
    typeof parsed.wsUrl !== "string" ||
    !parsed.wsUrl ||
    typeof parsed.token !== "string" ||
    typeof parsed.deviceId !== "string"
  ) {
    return null;
  }
  const seen = new Set<string>([parsed.wsUrl]);
  const wsUrls = [parsed.wsUrl];
  if (Array.isArray(parsed.wsUrls)) {
    for (const entry of parsed.wsUrls) {
      if (typeof entry !== "string" || !entry || seen.has(entry)) continue;
      seen.add(entry);
      wsUrls.push(entry);
      if (wsUrls.length >= WS_URLS_CAP) break;
    }
  }
  const lastGood =
    typeof parsed.lastGood === "string" && seen.has(parsed.lastGood) ? parsed.lastGood : undefined;
  const pushKey =
    typeof parsed.pushKey === "string" && parsed.pushKey ? parsed.pushKey : undefined;
  return {
    wsUrl: parsed.wsUrl,
    wsUrls,
    lastGood,
    pushKey,
    token: parsed.token,
    deviceId: parsed.deviceId,
  };
}

// The push key is stored twice: with the credentials (for the app) and in a
// sibling record under the shared access group (for the notification
// extension). The access group can fail where entitlements are missing
// (e.g. simulator builds); the credentials copy still works, so failures are
// swallowed here.
export async function savePushKey(pushKey: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(PUSH_KEY, pushKey, { accessGroup: PUSH_KEYCHAIN_GROUP });
  } catch {}
}

export async function loadPushKey(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(PUSH_KEY, { accessGroup: PUSH_KEYCHAIN_GROUP });
  } catch {
    return null;
  }
}

export async function saveCredentials(credentials: Credentials): Promise<void> {
  try {
    await SecureStore.setItemAsync(KEY, JSON.stringify(credentials));
  } catch {}
}

export async function loadCredentials(): Promise<Credentials | null> {
  try {
    const raw = await SecureStore.getItemAsync(KEY);
    if (!raw) return null;
    return normalizeCredentials(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function clearCredentials(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(KEY);
  } catch {}
}

// UI preferences (not secret): JSON in SecureStore, defaults on any error.
// archivedIds holds short keys (see sessionActions.archiveKey).
import { ARCHIVE_CAP } from "./sessionActions";

const PREFS_KEY = "zode.prefs.v1";

export interface Prefs {
  showWorkOrders: boolean;
  archivedIds: string[];
  showArchived: boolean;
  // Push notifications (PS3): the user's choice and the registered slot.
  pushEnabled: boolean;
  pushPromptShown: boolean;
  pushId: string | null;
}

function normalizePrefs(raw: unknown): Prefs {
  const value = (raw ?? {}) as {
    showWorkOrders?: unknown;
    archivedIds?: unknown;
    showArchived?: unknown;
    pushEnabled?: unknown;
    pushPromptShown?: unknown;
    pushId?: unknown;
  };
  return {
    showWorkOrders: value.showWorkOrders === true,
    showArchived: value.showArchived === true,
    archivedIds: Array.isArray(value.archivedIds)
      ? value.archivedIds
          .filter((entry): entry is string => typeof entry === "string")
          .slice(0, ARCHIVE_CAP)
      : [],
    pushEnabled: value.pushEnabled === true,
    pushPromptShown: value.pushPromptShown === true,
    pushId: typeof value.pushId === "string" && value.pushId ? value.pushId : null,
  };
}

export async function loadPrefs(): Promise<Prefs> {
  try {
    const raw = await SecureStore.getItemAsync(PREFS_KEY);
    if (!raw) return normalizePrefs(null);
    return normalizePrefs(JSON.parse(raw));
  } catch {
    return normalizePrefs(null);
  }
}

export async function savePrefs(prefs: Prefs): Promise<void> {
  try {
    await SecureStore.setItemAsync(PREFS_KEY, JSON.stringify(prefs));
  } catch {}
}
