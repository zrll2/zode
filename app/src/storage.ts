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
