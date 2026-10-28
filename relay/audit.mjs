// The approval audit log: every permission request Zode raised and every answer, one JSON line each
// in ~/.zode/approvals.jsonl. Pure Node, no deps. Every method swallows its errors — a full disk
// must never break an approval — and only facts are stored: tool, a 160-character summary, the
// risky flag and the session id, never the command or its arguments.
import fs from 'node:fs';
import path from 'node:path';

export const OUTCOMES = ['allowed', 'rejected', 'cancelled', 'unavailable'];
export const ANSWERERS = ['auto', 'phone', 'panel', 'none'];

const SUMMARY_MAX = 160;
const TOOL_MAX = 60;
const DEVICE_MAX = 60;
const ID_MAX = 200;
const SESSION_MAX = 120;

const clean = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// One log per call. First write wins per id (an in-memory set, rebuilt from the file lazily), and
// past maxLines the file is rewritten to the newest half, atomically.
export function createAuditLog({ file, now = Date.now, maxLines = 2000 } = {}) {
  const broken = typeof file !== 'string' || file === '';
  const askedIds = new Set();           // ids with an asked row already: the first one wins
  const decidedIds = new Set();         // ids with a decided row already: the first one wins
  let counted = false;                  // the line count is read once, then kept
  let lines = 0;
  const tmp = `${file}.${process.pid}.tmp`;

  const load = () => {
    if (counted || broken) return;
    counted = true;
    try {
      const text = fs.readFileSync(file, 'utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        lines += 1;
        try {
          const j = JSON.parse(line);
          if (j && typeof j.id === 'string') (j.e === 'asked' ? askedIds : decidedIds).add(j.id);
        } catch { /* a torn line is history */ }
      }
    } catch { lines = 0; }              // no file yet: nothing loaded
  };

  // Past the cap, keep the newest maxLines / 2 lines: read, tail, write beside and rename over.
  const truncate = () => {
    const keep = Math.max(1, Math.floor(maxLines / 2));
    try {
      const all = fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim());
      const kept = all.slice(-keep);
      fs.writeFileSync(tmp, kept.join('\n') + '\n', { mode: 0o600 });
      fs.chmodSync(tmp, 0o600);         // umask may have masked the mode
      fs.renameSync(tmp, file);
      lines = kept.length;
    } catch {
      try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
      counted = false;                  // recount from the file on the next write
    }
  };

  const append = (entry, kind) => {
    if (broken) return;
    load();
    const ids = kind === 'asked' ? askedIds : decidedIds;
    if (typeof entry.id !== 'string' || !entry.id || ids.has(entry.id)) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const fd = fs.openSync(file, 'a', 0o600);
      try { fs.writeSync(fd, JSON.stringify(entry) + '\n'); } finally { fs.closeSync(fd); }
      try { fs.chmodSync(file, 0o600); } catch { /* created with the mode; fine */ }
      ids.add(entry.id);
      lines += 1;
      if (lines > maxLines) truncate();
    } catch { /* a full disk must not break approvals */ }
  };

  const asked = ({ id, tool, summary, risky, sessionId } = {}) => {
    append({ e: 'asked', id: clean(id, ID_MAX), at: now(), tool: clean(tool, TOOL_MAX), summary: clean(summary, SUMMARY_MAX), risky: risky === true, sessionId: clean(sessionId, SESSION_MAX) }, 'asked');
  };

  const decided = ({ id, outcome, by, device } = {}) => {
    const name = clean(device, DEVICE_MAX);
    append({
      e: 'decided', id: clean(id, ID_MAX), at: now(),
      outcome: OUTCOMES.includes(outcome) ? outcome : 'unavailable',
      by: ANSWERERS.includes(by) ? by : 'none',
      ...(name ? { device: name } : {}),
    }, 'decided');
  };

  const recent = (limit = 50) => {
    try {
      load();
      const rows = new Map();           // id -> row, in file order so the newest line wins each field
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let j; try { j = JSON.parse(line); } catch { continue; }
        if (!j || typeof j.id !== 'string' || !j.id) continue;
        const row = rows.get(j.id) ?? { id: j.id, at: 0, tool: '', summary: '', risky: false, outcome: 'pending', by: 'none', device: null, askedAt: null };
        if (j.e === 'asked') {
          row.tool = typeof j.tool === 'string' ? j.tool : '';
          row.summary = typeof j.summary === 'string' ? j.summary : '';
          row.risky = j.risky === true;
          row.askedAt = typeof j.at === 'number' ? j.at : null;
          if (!row.at) row.at = row.askedAt ?? 0;
        } else if (j.e === 'decided') {
          row.outcome = OUTCOMES.includes(j.outcome) ? j.outcome : 'unavailable';
          row.by = ANSWERERS.includes(j.by) ? j.by : 'none';
          row.device = typeof j.device === 'string' ? j.device : null;
          row.at = typeof j.at === 'number' ? j.at : row.at;
        }
        rows.set(j.id, row);
      }
      return [...rows.values()].reverse().slice(0, Math.max(0, limit));   // newest first
    } catch { return []; }
  };

  return { asked, decided, recent };
}
