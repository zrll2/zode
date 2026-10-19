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
const PREFS_KEY = "zode.prefs.v1";

export interface Prefs {
  showWorkOrders: boolean;
}

export async function loadPrefs(): Promise<Prefs> {
  try {
    const raw = await SecureStore.getItemAsync(PREFS_KEY);
    if (!raw) return { showWorkOrders: false };
    const parsed = JSON.parse(raw);
    return { showWorkOrders: parsed?.showWorkOrders === true };
  } catch {
    return { showWorkOrders: false };
  }
}

export async function savePrefs(prefs: Prefs): Promise<void> {
  try {
    await SecureStore.setItemAsync(PREFS_KEY, JSON.stringify(prefs));
  } catch {}
}
