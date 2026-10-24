import * as SecureStore from "expo-secure-store";

const KEY = "zcode.relay.credentials.v1";

const WS_URLS_CAP = 8;

export interface Credentials {
  wsUrl: string;
  // Every address the pairing offered (and later learned from ready). The
  // phone races them and connects over whichever works.
  wsUrls: string[];
  // The address that last delivered a ready frame; tried first.
  lastGood?: string;
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
  return { wsUrl: parsed.wsUrl, wsUrls, lastGood, token: parsed.token, deviceId: parsed.deviceId };
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
}

function normalizePrefs(raw: unknown): Prefs {
  const value = (raw ?? {}) as {
    showWorkOrders?: unknown;
    archivedIds?: unknown;
    showArchived?: unknown;
  };
  return {
    showWorkOrders: value.showWorkOrders === true,
    showArchived: value.showArchived === true,
    archivedIds: Array.isArray(value.archivedIds)
      ? value.archivedIds
          .filter((entry): entry is string => typeof entry === "string")
          .slice(0, ARCHIVE_CAP)
      : [],
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
