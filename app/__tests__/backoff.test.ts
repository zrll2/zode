import { MAX_BACKOFF_MS, nextDelay, retryInSeconds } from "../src/relay/backoff";

describe("nextDelay", () => {
  it("applies the 0.85–1.15 jitter to the exponential base", () => {
    expect(nextDelay(0, () => 0)).toBe(850);
    expect(nextDelay(0, () => 1)).toBe(1150);
    expect(nextDelay(1, () => 0)).toBe(1700);
    expect(nextDelay(1, () => 1)).toBe(2300);
    expect(nextDelay(4, () => 0)).toBe(13_600);
    expect(nextDelay(4, () => 1)).toBe(18_400);
  });

  it("caps huge attempts at MAX_BACKOFF_MS", () => {
    expect(MAX_BACKOFF_MS).toBe(30_000);
    expect(nextDelay(20, () => 1)).toBe(MAX_BACKOFF_MS);
    const low = nextDelay(20, () => 0);
    expect(low).toBeGreaterThanOrEqual(MAX_BACKOFF_MS * 0.85);
    expect(low).toBeLessThanOrEqual(MAX_BACKOFF_MS);
  });
});

describe("retryInSeconds", () => {
  it("counts whole seconds down, never negative", () => {
    expect(retryInSeconds(30_000, 20_500)).toBe(10);
    expect(retryInSeconds(20_000, 20_000)).toBe(0);
    expect(retryInSeconds(19_999, 20_000)).toBe(0);
  });
});
