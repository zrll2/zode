import {
  clearCredentials,
  clearPushKey,
  loadCredentials,
  loadPrefs,
  loadPushKey,
  saveCredentials,
  savePrefs,
  savePushKey,
  setWebStorageOverride,
} from "../src/storage";

// Web build: the same records live in localStorage; SecureStore is never
// touched. Platform is mocked to web for this whole file and the storage
// itself is injected with setWebStorageOverride (no global window poking).
jest.mock("react-native", () => ({
  Platform: { OS: "web", select: (options: { web?: unknown }) => options.web },
}));

jest.mock("expo-secure-store", () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => undefined),
  deleteItemAsync: jest.fn(async () => undefined),
}));

const CREDENTIALS_KEY = "zcode.relay.credentials.v1";
const PREFS_KEY = "zode.prefs.v1";

const store = new Map<string, string>();
const fakeLocalStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
};

const credentials = {
  wsUrl: "ws://mac:8787",
  wsUrls: ["ws://mac:8787"],
  token: "tok",
  deviceId: "dev_1",
};

beforeEach(() => {
  store.clear();
  setWebStorageOverride(fakeLocalStorage);
});

describe("credentials in localStorage", () => {
  it("saves and loads credentials", async () => {
    await saveCredentials(credentials);
    expect(store.get(CREDENTIALS_KEY)).toBeTruthy();
    await expect(loadCredentials()).resolves.toEqual(credentials);
  });

  it("reads as no credentials when storage is empty", async () => {
    setWebStorageOverride(null);
    await expect(loadCredentials()).resolves.toBeNull();
  });

  it("reads as no credentials when storage is blocked", async () => {
    setWebStorageOverride({
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {},
    });
    await expect(saveCredentials(credentials)).resolves.toBeUndefined();
    await expect(loadCredentials()).resolves.toBeNull();
  });

  it("clears the record", async () => {
    await saveCredentials(credentials);
    await clearCredentials();
    expect(store.get(CREDENTIALS_KEY) ?? null).toBeNull();
    await expect(loadCredentials()).resolves.toBeNull();
  });
});

describe("prefs in localStorage", () => {
  it("round-trips prefs", async () => {
    const prefs = {
      showWorkOrders: true,
      archivedIds: ["abcd1234"],
      showArchived: true,
      pushEnabled: true,
      pushPromptShown: true,
      pushId: "push-1",
    };
    await savePrefs(prefs);
    await expect(loadPrefs()).resolves.toEqual(prefs);
  });
});

describe("push key helpers on web", () => {
  it("are no-ops (the extension keychain does not exist on web)", async () => {
    await expect(savePushKey("key")).resolves.toBeUndefined();
    await expect(loadPushKey()).resolves.toBeNull();
    await expect(clearPushKey()).resolves.toBeUndefined();
    expect(store.size).toBe(0);
  });
});
