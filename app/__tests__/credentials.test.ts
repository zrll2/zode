import * as SecureStore from "expo-secure-store";
import { loadCredentials, loadPushKey, saveCredentials, savePushKey } from "../src/storage";

jest.mock("expo-secure-store", () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

const mockedGet = SecureStore.getItemAsync as jest.Mock;
const mockedSet = SecureStore.setItemAsync as jest.Mock;

const KEY = "zcode.relay.credentials.v1";
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

it("migrates an old record that only has wsUrl", async () => {
  store[KEY] = JSON.stringify({
    wsUrl: "ws://192.168.86.46:8787",
    token: "tok",
    deviceId: "dev_1",
  });
  await expect(loadCredentials()).resolves.toEqual({
    wsUrl: "ws://192.168.86.46:8787",
    wsUrls: ["ws://192.168.86.46:8787"],
    lastGood: undefined,
    token: "tok",
    deviceId: "dev_1",
  });
});

it("round-trips the address list and the last good address", async () => {
  await saveCredentials({
    wsUrl: "ws://192.168.86.46:8787",
    wsUrls: ["ws://192.168.86.46:8787", "ws://100.86.6.90:8787"],
    lastGood: "ws://100.86.6.90:8787",
    token: "tok",
    deviceId: "dev_1",
  });
  await expect(loadCredentials()).resolves.toEqual({
    wsUrl: "ws://192.168.86.46:8787",
    wsUrls: ["ws://192.168.86.46:8787", "ws://100.86.6.90:8787"],
    lastGood: "ws://100.86.6.90:8787",
    token: "tok",
    deviceId: "dev_1",
  });
});

it("drops a lastGood that is not a known address", async () => {
  store[KEY] = JSON.stringify({
    wsUrl: "ws://a:1",
    wsUrls: ["ws://a:1", "ws://b:2"],
    lastGood: "ws://gone:9",
    token: "tok",
    deviceId: "dev_1",
  });
  const creds = await loadCredentials();
  expect(creds?.lastGood).toBeUndefined();
  expect(creds?.wsUrls).toEqual(["ws://a:1", "ws://b:2"]);
});

it("cleans junk out of the address list and keeps wsUrl first", async () => {
  store[KEY] = JSON.stringify({
    wsUrl: "ws://a:1",
    wsUrls: ["ws://b:2", 42, null, "ws://a:1", "ws://c:3"],
    token: "tok",
    deviceId: "dev_1",
  });
  await expect(loadCredentials()).resolves.toMatchObject({
    wsUrls: ["ws://a:1", "ws://b:2", "ws://c:3"],
  });
});

it("returns null for records without the required fields", async () => {
  store[KEY] = JSON.stringify({ wsUrl: "ws://a:1", token: "tok" });
  await expect(loadCredentials()).resolves.toBeNull();
  store[KEY] = "{not json";
  await expect(loadCredentials()).resolves.toBeNull();
  mockedGet.mockRejectedValue(new Error("keychain unavailable"));
  await expect(loadCredentials()).resolves.toBeNull();
});

describe("push key sibling record", () => {
  it("keeps the push key with the credentials when the pairing offers one", async () => {
    store[KEY] = JSON.stringify({
      wsUrl: "ws://a:1",
      wsUrls: ["ws://a:1"],
      pushKey: "cHVzaC1rZXktMzItYnl0ZXM",
      token: "tok",
      deviceId: "dev_1",
    });
    await expect(loadCredentials()).resolves.toMatchObject({
      pushKey: "cHVzaC1rZXktMzItYnl0ZXM",
    });
  });

  it("leaves pushKey undefined on old records (push unavailable until re-pair)", async () => {
    store[KEY] = JSON.stringify({ wsUrl: "ws://a:1", token: "tok", deviceId: "dev_1" });
    const creds = await loadCredentials();
    expect(creds?.pushKey).toBeUndefined();
  });

  it("round-trips the sibling record for the extension", async () => {
    await savePushKey("cHVzaC1rZXktMzItYnl0ZXM");
    expect(mockedSet).toHaveBeenCalledWith(
      "zode.push.key.v1",
      "cHVzaC1rZXktMzItYnl0ZXM",
      expect.objectContaining({ accessGroup: "XP5Q8LPH52.sg.comex.zode.shared" }),
    );
    await expect(loadPushKey()).resolves.toBe("cHVzaC1rZXktMzItYnl0ZXM");
  });
});
