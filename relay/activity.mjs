// When did a conversation REALLY last do something? The agent's `session/list` reports `updatedAt = now` for every
// conversation it has loaded into memory (for example everything ZCode restores at startup), so days-old
// conversations look like they just finished. ZCode's own database keeps the real time (`session.time_updated`,
// milliseconds), written when a message is. These helpers read it with the system `sqlite3`, read-only —
// asynchronously, at most three chunks in flight, 2 s per chunk — so a slow or locked database never blocks the
// relay's event loop. The last good answer is cached for 5 s: a failing database degrades to slightly stale data,
// then to an empty result. Nothing here throws.
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const defaultDb = () => process.env.ZCODE_AGENT_DB || path.join(os.homedir(), '.zcode', 'cli', 'db', 'db.sqlite');
const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;
const CHUNK = 200;              // keep each statement short
const PARALLEL = 3;             // at most three sqlite3 children at once
const CACHE_MS = 5000;          // how long the last good answer stands in for a failing database
const cache = new Map();        // dbPath -> { at, times: Map }; written on every success, read only on failure

// -> the query text, or null on any failure (no sqlite3, no database, past the deadline). Never rejects.
function queryChunk(chunk, dbPath) {
  return new Promise((resolve) => {
    const list = chunk.map(id => `'${id}'`).join(',');
    execFile('sqlite3', ['-readonly', '-cmd', '.timeout 1500', '-separator', '\t', dbPath, `SELECT id, time_updated FROM session WHERE id IN (${list})`],
      { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] },
      (err, text) => resolve(err ? null : String(text ?? '')));
  });
}

// Map of sessionId -> real last-activity time (ms) for the ids found in the database. A failed chunk's
// ids fall back to the cache while it is younger than CACHE_MS; successes refresh it.
export async function activityTimes(ids, dbPath = defaultDb(), { now = Date.now } = {}) {
  const out = new Map();
  const wanted = [...new Set((Array.isArray(ids) ? ids : []).filter(id => typeof id === 'string' && SAFE_ID.test(id)))];
  if (!wanted.length) return out;
  const chunks = [];
  for (let i = 0; i < wanted.length; i += CHUNK) chunks.push(wanted.slice(i, i + CHUNK));
  const failed = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(PARALLEL, chunks.length) }, async () => {
    while (next < chunks.length) {
      const chunk = chunks[next++];
      const text = await queryChunk(chunk, dbPath);
      if (text == null) { failed.push(chunk); continue; }
      for (const line of text.split('\n')) {
        const [id, t] = line.split('\t');
        const ms = Number(t);
        if (id && Number.isFinite(ms) && ms > 0) out.set(id, ms);
      }
    }
  }));
  if (out.size) {
    const times = cache.get(dbPath)?.times ?? new Map();
    for (const [id, ms] of out) times.set(id, ms);
    cache.set(dbPath, { at: now(), times });
  }
  if (failed.length) {
    const entry = cache.get(dbPath);
    if (entry && now() - entry.at < CACHE_MS) {
      for (const id of failed.flat()) if (!out.has(id) && entry.times.has(id)) out.set(id, entry.times.get(id));
    }
  }
  return out;
}

// The same sessions with `updatedAt` replaced by the real time where the database knows it.
export async function withRealActivity(sessions, dbPath, opts) {
  if (!Array.isArray(sessions) || sessions.length === 0) return sessions;
  const times = await activityTimes(sessions.map(s => s?.sessionId), dbPath, opts);
  if (times.size === 0) return sessions;
  return sessions.map(s => (s && times.has(s.sessionId) ? { ...s, updatedAt: times.get(s.sessionId) } : s));
}
