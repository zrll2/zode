// Token flow for the panel's monitor: tokens per minute over the last hour, the peak, and the average
// tokens and time of a work order. Numbers only, read-only, from the agent's own usage tables (never
// a conversation's text), counting new tokens only: cached re-reads of the context are left out, or every
// number would be dominated by them. A turn's tokens are spread evenly over the minutes it ran.
import os from 'node:os';
import path from 'node:path';

const MIN = 60 * 1000;
export const WINDOW_MIN = 60;
export const defaultDbPath = () => path.join(os.homedir(), '.zcode', 'cli', 'db', 'db.sqlite');

// turns: [{ start, end, tokens }] in ms; returns WINDOW_MIN per-minute buckets, oldest first.
export function bucketize(turns, now, windowMin = WINDOW_MIN) {
  const buckets = new Array(windowMin).fill(0);
  const origin = now - windowMin * MIN;
  for (const t of turns) {
    const start = Number(t.start), tokens = Number(t.tokens);
    if (!Number.isFinite(start) || !Number.isFinite(tokens) || tokens <= 0) continue;
    const end = Math.max(Number(t.end) || start, start + 1000);
    const rate = tokens / (end - start);                                   // tokens per ms
    const from = Math.max(start, origin), to = Math.min(end, now);
    for (let i = Math.floor((from - origin) / MIN); i < windowMin && origin + i * MIN < to; i++) {
      if (i < 0) continue;
      const a = Math.max(from, origin + i * MIN), b = Math.min(to, origin + (i + 1) * MIN);
      if (b > a) buckets[i] += rate * (b - a);
    }
  }
  return buckets.map(Math.round);
}

// { series, rate, peak, avgTokens, avgMs } or null when there is nothing to show.
export function summarizeFlow({ turns = [], orders = [] } = {}, now = Date.now()) {
  const series = bucketize(turns, now);
  const rate = Math.round(series.slice(-3).reduce((a, b) => a + b, 0) / 3);   // the last three minutes, per minute
  const peak = Math.max(0, ...series);
  const done = orders.filter(o => o.tokens > 0 && o.ms > 0);
  const avgTokens = done.length ? Math.round(done.reduce((a, o) => a + o.tokens, 0) / done.length) : 0;
  const avgMs = done.length ? Math.round(done.reduce((a, o) => a + o.ms, 0) / done.length) : 0;
  if (!peak && !avgTokens) return null;
  return { series, rate, peak, avgTokens, avgMs };
}

// Reads the agent's database. A work order is a conversation in a worktree (a folder ending in -wt) that
// had a finished turn in the last 7 days.
export async function readFlow({ dbPath = defaultDbPath(), now = Date.now(), open } = {}) {
  let db;
  try {
    const { DatabaseSync } = open ? { DatabaseSync: open } : await import('node:sqlite');
    db = new DatabaseSync(dbPath, { readOnly: true });
    const since = now - (WINDOW_MIN + 1) * MIN;
    const turns = db.prepare(`select started_at as start, coalesce(completed_at, started_at) as end, (computed_total_tokens - cache_read_input_tokens) as tokens
      from turn_usage where status != 'running' and coalesce(completed_at, started_at) >= ? and computed_total_tokens - cache_read_input_tokens > 0`).all(since);
    const orders = db.prepare(`select sum(u.computed_total_tokens - u.cache_read_input_tokens) as tokens, sum(coalesce(u.duration_ms, 0)) as ms
      from turn_usage u join session s on s.id = u.session_id
      where u.status = 'completed' and u.started_at >= ? and s.time_deleted is null and s.directory like '%-wt'
      group by u.session_id`).all(now - 7 * 24 * 60 * MIN);
    return summarizeFlow({ turns, orders }, now);
  } catch { return null; }
  finally { try { db?.close(); } catch { /* nothing open */ } }
}
