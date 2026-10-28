import {
  connectionHint,
  isPrivateLanAddress,
  isTailscaleAddress,
  offlineView,
} from "../src/connectionHint";

const BASE = {
  urls: ["ws://192.168.1.20:8787"],
  lastGood: "ws://192.168.1.20:8787" as string | null,
  status: "reconnecting",
  secondsDisconnected: 30,
};

describe("the 8 second reconnect window", () => {
  it("says nothing during the first seconds", () => {
    expect(connectionHint({ ...BASE, secondsDisconnected: 0 })).toBeNull();
    expect(connectionHint({ ...BASE, secondsDisconnected: 7 })).toBeNull();
  });

  it("speaks up from 8 seconds on", () => {
    expect(connectionHint({ ...BASE, secondsDisconnected: 8 })).not.toBeNull();
    expect(connectionHint({ ...BASE, secondsDisconnected: 120 })).not.toBeNull();
  });

  it("never speaks while connected", () => {
    expect(connectionHint({ ...BASE, status: "ready", secondsDisconnected: 0 })).toBeNull();
    expect(connectionHint({ ...BASE, status: "ready", secondsDisconnected: 999 })).toBeNull();
  });
});

describe("home Wi-Fi only (no Tailscale address known, connected before)", () => {
  it("tells the user how to learn the other way in", () => {
    const hint = connectionHint(BASE);
    expect(hint).toEqual({
      title: "Pair again",
      icon: "smartphone",
      body:
        "Open Zode once while you are on your home Wi-Fi so it can learn the other way in (Tailscale), or scan the pairing code again.",
      actions: [{ label: "Scan code again", kind: "scan" }],
    });
  });
});

describe("away from home with a Tailscale address known", () => {
  const AWAY = {
    urls: ["ws://192.168.1.20:8787", "ws://100.86.6.90:8787"],
    lastGood: "ws://100.86.6.90:8787" as string | null,
    status: "reconnecting",
    secondsDisconnected: 30,
  };

  it("points at Tailscale when the last good address was Tailscale", () => {
    const hint = connectionHint(AWAY);
    expect(hint?.title).toBe("Turn on Tailscale");
    expect(hint?.body).toContain("Open Tailscale on this phone");
    expect(hint?.actions).toEqual([
      { label: "Open Tailscale", kind: "tailscale" },
      { label: "Try again", kind: "retry", quiet: true },
    ]);
  });

  it("points at Tailscale when we cannot tell what worked last", () => {
    const hint = connectionHint({ ...AWAY, lastGood: null });
    expect(hint?.title).toBe("Turn on Tailscale");
  });

  it("points at Tailscale when only the Tailscale address is known", () => {
    const hint = connectionHint({ ...AWAY, urls: ["ws://100.86.6.90:8787"] });
    expect(hint?.title).toBe("Turn on Tailscale");
  });

  it("keeps the plain advice when home Wi-Fi was the last good address", () => {
    const hint = connectionHint({ ...AWAY, lastGood: "ws://192.168.1.20:8787" });
    expect(hint).toEqual({
      title: "Mac not reachable",
      icon: "monitor",
      body: "Your Mac is not reachable. Check that it is awake and on the same Wi-Fi.",
      actions: [{ label: "Try again", kind: "retry" }],
    });
  });
});

describe("never connected, LAN only", () => {
  it("gives the plain awake-and-same-Wi-Fi advice", () => {
    const hint = connectionHint({ ...BASE, lastGood: null, status: "connecting" });
    expect(hint).toEqual({
      title: "Mac not reachable",
      icon: "monitor",
      body: "Your Mac is not reachable. Check that it is awake and on the same Wi-Fi.",
      actions: [{ label: "Try again", kind: "retry" }],
    });
  });
});

describe("offlineView", () => {
  it("shows the centred dots while offline and nothing has loaded", () => {
    expect(offlineView({ status: "connecting", connectedOnce: false, hint: false })).toBe("dots");
    expect(offlineView({ status: "reconnecting", connectedOnce: false, hint: false })).toBe("dots");
    expect(offlineView({ status: "closed", connectedOnce: true, hint: false })).toBe("dots");
  });

  it("shows the hint once it is up, whatever the history", () => {
    expect(offlineView({ status: "reconnecting", connectedOnce: true, hint: true })).toBe("hint");
    expect(offlineView({ status: "connecting", connectedOnce: false, hint: true })).toBe("hint");
  });

  it("keeps skeleton rows only for the connected-but-still-loading moment", () => {
    expect(offlineView({ status: "ready", connectedOnce: false, hint: false })).toBe("skeleton");
  });

  it("shows the list once connected and loaded", () => {
    expect(offlineView({ status: "ready", connectedOnce: true, hint: false })).toBe("list");
  });
});

describe("address classifiers", () => {
  it("recognises Tailscale addresses (100.64.0.0/10)", () => {
    expect(isTailscaleAddress("ws://100.64.0.1:8787")).toBe(true);
    expect(isTailscaleAddress("ws://100.127.255.254")).toBe(true);
    expect(isTailscaleAddress("ws://100.63.0.1:8787")).toBe(false);
    expect(isTailscaleAddress("ws://100.128.0.1:8787")).toBe(false);
    expect(isTailscaleAddress("ws://example.com")).toBe(false);
    expect(isTailscaleAddress("")).toBe(false);
  });

  it("recognises private LAN addresses", () => {
    expect(isPrivateLanAddress("ws://192.168.1.20:8787")).toBe(true);
    expect(isPrivateLanAddress("ws://10.0.0.2:8787")).toBe(true);
    expect(isPrivateLanAddress("wss://172.16.1.1")).toBe(true);
    expect(isPrivateLanAddress("wss://172.31.255.1")).toBe(true);
    expect(isPrivateLanAddress("ws://172.15.0.1:8787")).toBe(false);
    expect(isPrivateLanAddress("ws://172.32.0.1:8787")).toBe(false);
    expect(isPrivateLanAddress("ws://8.8.8.8")).toBe(false);
    expect(isPrivateLanAddress("ws://example.com")).toBe(false);
  });
});
