import { usageChip } from "../src/usage";

describe("usageChip", () => {
  it("rounds the percent", () => {
    expect(usageChip(420, 1000)).toMatchObject({ label: "42%", tone: "normal", percent: 42 });
    expect(usageChip(428, 1000)).toMatchObject({ label: "43%", tone: "normal", percent: 43 });
    expect(usageChip(0, 1000)).toMatchObject({ label: "0%", tone: "normal", percent: 0 });
  });

  it("clamps to 0..100", () => {
    expect(usageChip(1500, 1000)).toMatchObject({ label: "100%", tone: "danger", percent: 100 });
    expect(usageChip(-50, 1000)).toMatchObject({ label: "0%", tone: "normal", percent: 0 });
  });

  it("switches tone at 70 percent (after rounding)", () => {
    expect(usageChip(690, 1000)?.tone).toBe("normal");
    expect(usageChip(693, 1000)?.tone).toBe("normal");
    expect(usageChip(696, 1000)?.tone).toBe("warn");
    expect(usageChip(700, 1000)?.tone).toBe("warn");
  });

  it("switches tone at 90 percent (after rounding)", () => {
    expect(usageChip(890, 1000)?.tone).toBe("warn");
    expect(usageChip(893, 1000)?.tone).toBe("warn");
    expect(usageChip(896, 1000)?.tone).toBe("danger");
    expect(usageChip(900, 1000)?.tone).toBe("danger");
  });

  it("returns null without a usable window", () => {
    expect(usageChip(0, null)).toBeNull();
    expect(usageChip(0, 0)).toBeNull();
    expect(usageChip(0, -5)).toBeNull();
    expect(usageChip(0, undefined)).toBeNull();
    expect(usageChip(0, "big")).toBeNull();
    expect(usageChip(0, NaN)).toBeNull();
  });

  it("treats a non-number used value as zero", () => {
    expect(usageChip(undefined, 1000)).toMatchObject({ label: "0%", tone: "normal" });
    expect(usageChip(null, 1000)).toMatchObject({ label: "0%", tone: "normal" });
    expect(usageChip("lots", 1000)).toMatchObject({ label: "0%", tone: "normal" });
    expect(usageChip(NaN, 1000)).toMatchObject({ label: "0%", tone: "normal" });
  });
});
