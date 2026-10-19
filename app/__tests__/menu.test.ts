import { buildMenuItems } from "../src/ui/menu";
import { PRIVACY_URL, SUPPORT_URL } from "../src/config";

describe("buildMenuItems", () => {
  it("lists privacy, support, unpair and cancel when paired", () => {
    const items = buildMenuItems({ demo: false });
    expect(items.map((item) => item.key)).toEqual([
      "privacy",
      "support",
      "unpair",
      "cancel",
    ]);
    expect(items.find((item) => item.key === "exit-demo")).toBeUndefined();
  });

  it("swaps unpair for exit demo in demo mode", () => {
    const items = buildMenuItems({ demo: true });
    expect(items.map((item) => item.key)).toEqual([
      "privacy",
      "support",
      "exit-demo",
      "cancel",
    ]);
    expect(items.find((item) => item.key === "unpair")).toBeUndefined();
  });

  it("marks only unpair and exit demo as destructive", () => {
    for (const demo of [false, true]) {
      for (const item of buildMenuItems({ demo })) {
        const shouldBeDestructive = item.key === "unpair" || item.key === "exit-demo";
        expect(item.destructive).toBe(shouldBeDestructive ? true : undefined);
      }
    }
  });

  it("uses https urls for the about entries", () => {
    expect(PRIVACY_URL.startsWith("https://")).toBe(true);
    expect(SUPPORT_URL.startsWith("https://")).toBe(true);
  });
});
