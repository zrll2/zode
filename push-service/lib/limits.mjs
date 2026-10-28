// Abuse limits. Honest caveat: serverless instances are short lived and run side by side, so these
// in-memory buckets are per instance and vanish on every deploy or scale-out — best effort only.
// The hard caps that always apply are the 8 KB body and APNs' own feedback.
const MAX_KEYS = 10000;                       // when full, the oldest keys are evicted so the map cannot grow without bound

// A token bucket: `capacity` is the burst, `perMs` the steady refill rate. take() is false when dry.
export function createBucket({ capacity, perMs }) {
  const buckets = new Map();
  const take = function take(key, now = Date.now()) {
    if (buckets.size >= MAX_KEYS && !buckets.has(key)) {
      for (const k of buckets.keys()) {         // a Map iterates oldest-inserted first: drop from the front
        buckets.delete(k);
        if (buckets.size < MAX_KEYS) break;
      }
    }
    let b = buckets.get(key);
    if (!b) buckets.set(key, b = { tokens: capacity, at: now });
    b.tokens = Math.min(capacity, b.tokens + (now - b.at) * perMs);
    b.at = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  };
  return Object.assign(take, { take });                 // callable, and `.take(key, now)` for the handlers
}

// Pushes: 30 per minute per push id, at most 10 in one burst.
export const pushBucket = () => createBucket({ capacity: 10, perMs: 30 / 60_000 });
// Registrations: 20 per hour per IP.
export const registerBucket = () => createBucket({ capacity: 20, perMs: 20 / 3_600_000 });
