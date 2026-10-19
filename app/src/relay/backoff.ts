export const MAX_BACKOFF_MS = 30_000;

// Exponential reconnect backoff with ±15 % jitter so many phones do not
// retry in lock-step; the result never exceeds MAX_BACKOFF_MS.
export function nextDelay(attempt: number, rng: () => number = Math.random): number {
  const base = Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS);
  return Math.min(base * (0.85 + rng() * 0.3), MAX_BACKOFF_MS);
}

// Whole seconds from `now` until the next retry, never negative.
export function retryInSeconds(retryAt: number, now: number): number {
  return Math.max(0, Math.ceil((retryAt - now) / 1000));
}
