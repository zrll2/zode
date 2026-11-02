// Remembered answers to ZCode questions: when the user answers an option question once, the same
// question asked again can be answered the same way. Pure storage: JSON in one file (0600, atomic
// write), newest first, capped. Free-text questions are never remembered.
import fs from 'node:fs';
import path from 'node:path';

// A stable key for one question block: the trimmed, lowercased, whitespace-collapsed question text
// plus its sorted option labels (so option order never matters). Questions without options are
// free-text: keyOf returns null and nothing is remembered for them.
export function keyOf(question) {
  if (!question || typeof question !== 'object') return null;
  const text = typeof question.question === 'string' ? question.question.trim().replace(/\s+/g, ' ').toLowerCase() : '';
  if (!text) return null;
  const labels = (Array.isArray(question.options) ? question.options : [])
    .map(o => (o && typeof o.label === 'string' ? o.label.trim().replace(/\s+/g, ' ').toLowerCase() : ''))
    .filter(Boolean);
  if (!labels.length) return null;
  return JSON.stringify([text, [...new Set(labels)].sort()]);
}

export function createDecisions({ file, now = Date.now, cap = 200 } = {}) {
  // Missing or corrupt file means empty; junk shapes inside are dropped, so a broken line never
  // takes the whole memory down.
  const load = () => {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      const entries = Array.isArray(raw) ? raw : [];
      return entries.filter(e => e && typeof e === 'object' && typeof e.key === 'string' && e.key
        && (typeof e.answer === 'string' || (Array.isArray(e.answer) && e.answer.length)));
    } catch { return []; }
  };
  let entries = load();

  // Write beside the target and rename over it, mode 0600, like every other state file. A failed
  // save keeps the in-memory list (and the old file) intact.
  const persist = () => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(entries) + '\n', { mode: 0o600 });
      fs.chmodSync(tmp, 0o600);                                        // umask may have masked the mode
      fs.renameSync(tmp, file);
    } catch { /* the memory still works, it just may not survive a restart */ }
  };

  return {
    remember(question, answer) {
      const key = keyOf(question);
      if (!key) return false;
      const ok = typeof answer === 'string' ? answer.length > 0
        : Array.isArray(answer) && answer.length > 0 && answer.every(l => typeof l === 'string' && l.length > 0);
      if (!ok) return false;
      entries = entries.filter(e => e.key !== key);                    // the newest answer wins
      entries.unshift({ key, at: now(), answer });
      if (entries.length > cap) entries.length = cap;
      persist();
      return true;
    },
    // The remembered answer for an identical question — but only while every remembered label is
    // still one of the question's current options; a changed question is a new question.
    lookup(question) {
      const key = keyOf(question);
      if (!key) return null;
      const entry = entries.find(e => e.key === key);
      if (!entry) return null;
      const labels = new Set((Array.isArray(question.options) ? question.options : [])
        .map(o => (o && typeof o.label === 'string' ? o.label : '')).filter(Boolean));
      const current = a => (Array.isArray(a) ? a : [a]).every(l => labels.has(l));
      return current(entry.answer) ? entry.answer : null;
    },
    forget() {
      const n = entries.length;
      entries = [];
      persist();
      return n;
    },
    size: () => entries.length,
  };
}
