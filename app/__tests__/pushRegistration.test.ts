import * as SecureStore from "expo-secure-store";
import {
  disablePush,
  enablePush,
  ensurePushOnStart,
  pushRowLabel,
  registerPush,
  type PushNotificationsApi,
} from "../src/pushRegistration";

jest.mock("expo-notifications", () => ({
  requestPermissionsAsync: jest.fn(async () => ({ granted: true })),
  getDevicePushTokenAsync: jest.fn(async () => ({ type: "ios", data: "aabbcc" })),
  addPushTokenListener: jest.fn(() => ({ remove: jest.fn() })),
}));

jest.mock("expo-secure-store", () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => undefined),
  deleteItemAsync: jest.fn(async () => undefined),
}));

const KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";

function fakeNotifications(granted = true) {
  return {
    requestPermissionsAsync: jest.fn(async () => ({ granted })),
    getDevicePushTokenAsync: jest.fn(async () => ({ type: "ios", data: "aabbcc" })),
    addPushTokenListener: jest.fn(() => ({ remove: jest.fn() })),
  } as unknown as PushNotificationsApi & Record<string, jest.Mock>;
}

function fetchOk() {
  return jest.fn(async () => ({
    ok: true,
    json: async () => ({ pushId: "push-1", secret: "secret-1" }),
  })) as unknown as typeof fetch;
}

const base = { pushKey: KEY, fetchImpl: fetchOk() };

describe("registerPush", () => {
  it("runs register and rpc in order with the right env", async () => {
    const calls: string[] = [];
    const notifications = fakeNotifications();
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      json: async () => ({ pushId: "push-1", secret: "secret-1" }),
    })) as unknown as typeof fetch;
    const rpc = jest.fn(async (method: string, params?: unknown) => {
      calls.push(method);
      calls.push(JSON.stringify(params));
      return {};
    });

    const state = await registerPush({
      notifications,
      fetchImpl,
      rpc: rpc as any,
      pushKey: KEY,
      env: "sandbox",
    });

    expect(state).toBe("enabled");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://zode-push.vercel.app/api/register",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          deviceToken: "aabbcc",
          env: "sandbox",
          bundleId: "sg.comex.zode",
        }),
      }),
    );
    expect(rpc).toHaveBeenCalledWith("push/register", {
      pushId: "push-1",
      secret: "secret-1",
      env: "sandbox",
    });
    expect(calls).toEqual(["push/register", '{"pushId":"push-1","secret":"secret-1","env":"sandbox"}']);
  });

  it("uses production env when told", async () => {
    const rpc = jest.fn(async () => ({}));
    await registerPush({ ...base, rpc: rpc as any, env: "production" });
    expect(rpc).toHaveBeenCalledWith("push/register", {
      pushId: "push-1",
      secret: "secret-1",
      env: "production",
    });
  });

  it("is unavailable without a push key", async () => {
    const state = await registerPush({ notifications: fakeNotifications(), rpc: jest.fn() });
    expect(state).toBe("unavailable");
  });

  it("is denied when permission is refused", async () => {
    const state = await registerPush({
      ...base,
      notifications: fakeNotifications(false),
      rpc: jest.fn(),
    });
    expect(state).toBe("denied");
  });

  it("stays off when the push service fails", async () => {
    const fetchImpl = jest.fn(async () => ({
      ok: false,
      json: async () => ({}),
    })) as unknown as typeof fetch;
    const rpc = jest.fn(async () => ({}));
    const state = await registerPush({ ...base, fetchImpl, rpc: rpc as any });
    expect(state).toBe("off");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("stays off when the relay rpc fails", async () => {
    const rpc = jest.fn(async () => {
      throw new Error("relay down");
    });
    const state = await registerPush({ ...base, rpc: rpc as any });
    expect(state).toBe("off");
  });

  it("never throws", async () => {
    const notifications = {
      requestPermissionsAsync: async () => {
        throw new Error("boom");
      },
      getDevicePushTokenAsync: async () => ({ type: "ios", data: "x" }),
      addPushTokenListener: () => ({ remove: () => {} }),
    } as unknown as PushNotificationsApi;
    await expect(registerPush({ ...base, notifications })).resolves.toBe("off");
    await expect(
      registerPush({
        ...base,
        notifications: fakeNotifications(),
        fetchImpl: (() => {
          throw new Error("sync");
        }) as unknown as typeof fetch,
      }),
    ).resolves.toBe("off");
  });
});

describe("ensurePushOnStart", () => {
  it("does nothing when push was never enabled", async () => {
    const rpc = jest.fn(async () => ({}));
    const state = await ensurePushOnStart({
      ...base,
      rpc: rpc as any,
      loadPrefs: async () => ({ pushEnabled: false }),
    });
    expect(state).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("re-registers on start when enabled", async () => {
    const state = await ensurePushOnStart({
      ...base,
      rpc: jest.fn(async () => ({})) as any,
      loadPrefs: async () => ({ pushEnabled: true }),
    });
    expect(state).toBe("enabled");
  });
});

describe("enablePush and the menu label", () => {
  it("persists the enabled choice", async () => {
    const saved: boolean[] = [];
    const state = await enablePush({
      ...base,
      rpc: jest.fn(async () => ({})) as any,
      savePushEnabled: async (enabled) => {
        saved.push(enabled);
      },
    });
    expect(state).toBe("enabled");
    expect(saved).toEqual([true]);
  });

  it("labels every state without a full stop", () => {
    expect(pushRowLabel("enabled")).toBe("Notifications: On");
    expect(pushRowLabel("off")).toBe("Notifications: Off");
    expect(pushRowLabel("denied")).toBe("Notifications: Denied");
    expect(pushRowLabel("unavailable")).toBe("Notifications: Pair again");
  });
});

describe("pushId persistence", () => {
  it("stores the registered pushId after a successful registration", async () => {
    const savePushId = jest.fn(async () => {});
    const state = await registerPush({
      ...base,
      rpc: jest.fn(async () => ({})) as any,
      savePushId,
    });
    expect(state).toBe("enabled");
    expect(savePushId).toHaveBeenCalledWith("push-1");
  });

  it("persists the pushId into prefs through the default helper", async () => {
    const state = await registerPush({
      ...base,
      rpc: jest.fn(async () => ({})) as any,
    });
    expect(state).toBe("enabled");
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
      "zode.prefs.v1",
      expect.stringContaining('"pushId":"push-1"'),
    );
  });

  it("does not store a pushId when the relay rpc fails", async () => {
    const savePushId = jest.fn(async () => {});
    const rpc = jest.fn(async () => {
      throw new Error("relay down");
    });
    const state = await registerPush({ ...base, rpc: rpc as any, savePushId });
    expect(state).toBe("off");
    expect(savePushId).not.toHaveBeenCalled();
  });

  it("disablePush unregisters with the stored pushId and clears it", async () => {
    const rpc = jest.fn(async () => ({}));
    const savePushId = jest.fn(async () => {});
    await disablePush({ pushId: "push-1", rpc: rpc as any, savePushId });
    expect(rpc).toHaveBeenCalledWith("push/unregister", { pushId: "push-1" });
    expect(savePushId).toHaveBeenCalledWith(null);
  });

  it("disablePush clears the stored pushId even when none was stored", async () => {
    const rpc = jest.fn(async () => ({}));
    const savePushId = jest.fn(async () => {});
    await disablePush({ rpc: rpc as any, savePushId });
    expect(rpc).not.toHaveBeenCalled();
    expect(savePushId).toHaveBeenCalledWith(null);
  });
});
