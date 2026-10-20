import * as SecureStore from "expo-secure-store";

const KEY = "zcode.relay.credentials.v1";

export interface Credentials {
  wsUrl: string;
  token: string;
  deviceId: string;
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
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed.wsUrl === "string" &&
      typeof parsed.token === "string" &&
      typeof parsed.deviceId === "string"
    ) {
      return parsed as Credentials;
    }
    return null;
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
