// When did a conversation REALLY last do something? The agent's `session/list` reports `updatedAt = now` for every
// conversation it has loaded into memory (for example everything ZCode restores at startup), so days-old
// conversations look like they just finished. ZCode's own database keeps the real time (`session.time_updated`,
// milliseconds), written when a message is. These helpers read it with the system `sqlite3`, read-only.
// Nothing here throws: no sqlite3, no database or a locked one just leaves the times as they were.
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const defaultDb = () => process.env.ZCODE_AGENT_DB || path.join(os.homedir(), '.zcode', 'cli', 'db', 'db.sqlite');
const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;

// Map of sessionId -> real last-activity time (ms) for the ids found in the database.
export function activityTimes(ids, dbPath = defaultDb()) {
  const out = new Map();
  try {
    const list = [...new Set((Array.isArray(ids) ? ids : []).filter(id => typeof id === 'string' && SAFE_ID.test(id)))];
    for (let i = 0; i < list.length; i += 200) {                       // keep each statement short
      const chunk = list.slice(i, i + 200).map(id => `'${id}'`).join(',');
      const text = execFileSync('sqlite3', ['-readonly', '-cmd', '.timeout 1500', '-separator', '\t', dbPath, `SELECT id, time_updated FROM session WHERE id IN (${chunk})`], { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] });
      for (const line of text.split('\n')) {
        const [id, t] = line.split('\t');
        const ms = Number(t);
        if (id && Number.isFinite(ms) && ms > 0) out.set(id, ms);
      }
    }
  } catch { /* leave whatever was read */ }
  return out;
}

// The same sessions with `updatedAt` replaced by the real time where the database knows it.
export function withRealActivity(sessions, dbPath) {
  if (!Array.isArray(sessions) || sessions.length === 0) return sessions;
  const times = activityTimes(sessions.map(s => s?.sessionId), dbPath);
  if (times.size === 0) return sessions;
  return sessions.map(s => (s && times.has(s.sessionId) ? { ...s, updatedAt: times.get(s.sessionId) } : s));
}
