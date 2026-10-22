import { friendlyError } from "../src/friendlyError";

describe("friendlyError", () => {
  it("explains unreachable Macs", () => {
    for (const m of [
      "Pairing timed out. Check that this phone can reach the Mac.",
      "Network request failed",
      "relay: timed out waiting for ready",
      "relay: not connected (connecting)",
      "relay: closed before ready",
      "relay: disconnected",
    ]) {
      expect(friendlyError(new Error(m))).toMatch(/Can't reach your Mac/);
    }
  });

  it("explains a bad or expired pairing code while pairing", () => {
    expect(friendlyError(new Error("relay: pairing rejected (bad token)"), "pair")).toMatch(/This code didn't work/);
    expect(friendlyError(new Error("Pairing failed (HTTP 401). Is the relay running?"), "pair")).toMatch(/This code didn't work/);
  });

  it("tells the user to pair again when the saved token stops working", () => {
    expect(friendlyError(new Error("relay: pairing rejected (bad token)"), "connect")).toMatch(/no longer paired/);
  });

  it("rejects text that is not a pairing code", () => {
    expect(friendlyError(new Error("That is not valid JSON. Paste the pairing text."), "pair")).toMatch(/doesn't look like a Zode pairing code/);
    expect(friendlyError(new Error("Pairing text is missing u, w or c."), "pair")).toMatch(/doesn't look like/);
  });

  it("passes unknown messages through and handles empty input", () => {
    expect(friendlyError(new Error("Something odd"))).toBe("Something odd");
    expect(friendlyError(undefined, "pair")).toMatch(/Pairing didn't work/);
    expect(friendlyError("")).toMatch(/Something went wrong/);
  });
});
