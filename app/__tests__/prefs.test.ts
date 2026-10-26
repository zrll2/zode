import * as SecureStore from "expo-secure-store";
import { loadPrefs, savePrefs } from "../src/storage";

jest.mock("expo-secure-store", () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

const mockedGet = SecureStore.getItemAsync as jest.Mock;
const mockedSet = SecureStore.setItemAsync as jest.Mock;

const PREFS_KEY = "zode.prefs.v1";
let store: Record<string, string> = {};

beforeEach(() => {
  store = {};
  mockedGet.mockReset();
  mockedSet.mockReset();
  mockedGet.mockImplementation(async (key: string) => store[key] ?? null);
  mockedSet.mockImplementation(async (key: string, value: string) => {
    store[key] = value;
  });
});

it("defaults every field", async () => {
  mockedGet.mockResolvedValue(null);
  await expect(loadPrefs()).resolves.toEqual({
    showWorkOrders: false,
    archivedIds: [],
    showArchived: false,
    pushEnabled: false,
    pushPromptShown: false,
    pushId: null,
  });
});

it("round-trips saved prefs including archived ids", async () => {
  const prefs = {
    showWorkOrders: true,
    archivedIds: ["abcd1234"],
    showArchived: true,
    pushEnabled: true,
    pushPromptShown: true,
    pushId: "push-1",
  };
  await savePrefs(prefs);
  expect(mockedSet).toHaveBeenCalledWith(PREFS_KEY, JSON.stringify(prefs));
  await expect(loadPrefs()).resolves.toEqual(prefs);
});

it("loads an old format without the new fields with defaults", async () => {
  store[PREFS_KEY] = JSON.stringify({ showWorkOrders: true });
  await expect(loadPrefs()).resolves.toEqual({
    showWorkOrders: true,
    archivedIds: [],
    showArchived: false,
    pushEnabled: false,
    pushPromptShown: false,
    pushId: null,
  });
});

it("gives defaults on corrupt JSON", async () => {
  store[PREFS_KEY] = "{not json at all";
  await expect(loadPrefs()).resolves.toEqual({
    showWorkOrders: false,
    archivedIds: [],
    showArchived: false,
    pushEnabled: false,
    pushPromptShown: false,
    pushId: null,
  });
});

it("gives defaults when the store itself fails", async () => {
  mockedGet.mockRejectedValue(new Error("keychain unavailable"));
  await expect(loadPrefs()).resolves.toEqual({
    showWorkOrders: false,
    archivedIds: [],
    showArchived: false,
    pushEnabled: false,
    pushPromptShown: false,
    pushId: null,
  });
  await expect(savePrefs({ showWorkOrders: true, archivedIds: [], showArchived: false, pushEnabled: false, pushPromptShown: false, pushId: null }))
    .resolves.toBeUndefined();
});
