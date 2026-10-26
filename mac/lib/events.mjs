// The Zode event feed: one JSON line per notification decision, appended to <dir>/events.jsonl.
// Claude Code sessions (via the shipped zode-watch watcher) follow it to learn when Zode work
// finishes, fails, needs an answer or looks stuck. Content rules: states, times, counts, the
// conversation title and the workspace path — never commands, file contents or message text.
import fs from 'node:fs';
import path from 'node:path';

const FILE = 'events.jsonl';
const KINDS = new Set(['finished', 'failed', 'needs', 'stuck']);

const str = (v, max) => String(v ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, max);

// The exact JSON line for one event, or null when the event is junk (unknown kind, no session).
export function eventLine(event, at = Date.now()) {
  try {
    if (!event || typeof event !== 'object') return null;
    if (!KINDS.has(event.kind)) return null;
    if (typeof event.sessionId !== 'string' || !event.sessionId) return null;
    return JSON.stringify({
      v: 1,
      at: Math.floor(Number(at) || 0),
      kind: event.kind,
      sessionId: str(event.sessionId, 120),
      project: str(event.project, 200),
      title: str(event.title, 120),
      workspace: str(event.workspace, 500),
    });
  } catch {
    return null;
  }
}

// Appends are fire-and-forget from the notification tick, so they are chained to keep the file
// ordered, and rotation happens before an append that would push the file past maxBytes: the old
// file becomes events.jsonl.1 (replaced) and a fresh one starts.
export function createEventFeed({ dir, now = Date.now, maxBytes = 512 * 1024 } = {}) {
  let chain = Promise.resolve();
  const doAppend = (line) => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, FILE);
      try {
        if (fs.statSync(file).size > maxBytes) fs.renameSync(file, `${file}.1`);   // replaced, one generation kept
      } catch { /* no file yet */ }
      fs.appendFileSync(file, line + '\n', { mode: 0o600 });
      return true;
    } catch {
      return false;
    }
  };
  return {
    file: path.join(dir ?? '', FILE),
    async append(event) {
      const line = eventLine(event, now());
      if (!line) return false;
      chain = chain.then(() => doAppend(line));
      try {
        await chain;
        return true;
      } catch {
        return false;
      }
    },
  };
}
