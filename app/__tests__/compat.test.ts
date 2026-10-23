import { isOutdated, MIN_PROTOCOL, outdatedMessage, relaySupports } from "../src/compat";

describe("relaySupports", () => {
  it("treats a missing protocol as an old relay (protocol 1)", () => {
    expect(relaySupports(undefined, "rename")).toBe(false);
    expect(relaySupports(undefined, "usage")).toBe(false);
    expect(relaySupports(undefined, "attachments")).toBe(false);
    expect(relaySupports(undefined, "askFirst")).toBe(false);
  });

  it("treats protocol 1 as too old", () => {
    expect(relaySupports(1, "rename")).toBe(false);
    expect(relaySupports(1, "askFirst")).toBe(false);
  });

  it("supports every guarded feature at protocol 2", () => {
    for (const feature of Object.keys(MIN_PROTOCOL) as (keyof typeof MIN_PROTOCOL)[]) {
      expect(relaySupports(2, feature)).toBe(true);
    }
  });

  it("supports newer protocols too", () => {
    expect(relaySupports(3, "rename")).toBe(true);
    expect(relaySupports(3, "usage")).toBe(true);
  });

  it("treats junk values as an old relay", () => {
    expect(relaySupports("2" as unknown as number, "rename")).toBe(false);
    expect(relaySupports(NaN, "attachments")).toBe(false);
    expect(relaySupports(null as unknown as number, "askFirst")).toBe(false);
  });
});

describe("outdatedMessage", () => {
  it("builds one plain sentence for a single feature", () => {
    expect(outdatedMessage(["rename chats"])).toBe(
      "Your Mac is running an older Zode. Update Zode on your Mac to rename chats.",
    );
  });

  it("joins several features into one sentence", () => {
    const message = outdatedMessage(["rename chats", "see usage", "attach photos and files"]);
    expect(message).toBe(
      "Your Mac is running an older Zode. Update Zode on your Mac to rename chats, see usage, and attach photos and files.",
    );
  });
});

describe("isOutdated", () => {
  it("is true for missing, old, and junk protocols", () => {
    expect(isOutdated(undefined)).toBe(true);
    expect(isOutdated(1)).toBe(true);
    expect(isOutdated("2" as unknown as number)).toBe(true);
  });

  it("is false once the relay is current", () => {
    expect(isOutdated(2)).toBe(false);
    expect(isOutdated(3)).toBe(false);
  });
});
