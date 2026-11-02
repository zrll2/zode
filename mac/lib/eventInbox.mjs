// The event inbox: anything on this Mac (a webhook forwarder, a cron job, a CI script) drops one
// small JSON event file into ~/.zode/events/ and Zode wakes a ZCode session with it. The folder
// stays empty: every file is delivered or deleted, and only the normalized event survives. Same
// shape as bannerInbox.mjs; the events are parsed by the pure triggers core.
import fs from 'node:fs';
import path from 'node:path';
import { normalizeEvent } from './triggers.mjs';

const MAX_AGE_MS = 300_000;
const MAX_FILES = 50;

// text -> { source, type, subject, summary, link } | null. A JSON object that normalizeEvent
// accepts; stale drops (older than 300 s), non-JSON text and junk are null. Never throws.
export function parseEventFile(text, ageMs) {
  try {
    if (typeof text !== 'string') return null;
    if (!Number.isFinite(ageMs) || ageMs > MAX_AGE_MS) return null;
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return normalizeEvent(parsed);
  } catch {
    return null;
  }
}

// Watch the drop folder. Every existing *.json is processed once, then fs.watch picks up new ones
// (the scan cap keeps a flooded folder from wedging the startup). Each file is read, parsed with
// its mtime age, delivered when valid, and deleted either way. Never throws.
export function startEventInbox({ dir, onEvent, fs: nodeFs = fs, now = Date.now } = {}) {
  const seen = new Set();

  const handle = (name, tries = 0) => {
    if (tries === 0 && seen.has(name)) return;
    seen.add(name);
    if (!name.endsWith('.json')) return;
    const file = path.join(dir, name);
    let text = null;
    let mtimeMs = 0;
    try {
      text = nodeFs.readFileSync(file, 'utf8');
      mtimeMs = nodeFs.statSync(file).mtimeMs;
    } catch { return; }                                               // already gone: someone else delivered it
    // A watcher event can fire the moment the file is created, before the writer has put the JSON
    // in. An empty read is "not there yet": back off briefly and look again instead of eating it.
    if (text === '' && tries < 6) {
      seen.delete(name);
      const retry = setTimeout(() => handle(name, tries + 1), 40);
      retry.unref?.();
      return;
    }
    let event = null;
    try { event = parseEventFile(text, now() - mtimeMs); } catch { event = null; }
    if (event) {
      try { onEvent(event); } catch { /* the event is still consumed */ }
    }
    try { nodeFs.unlinkSync(file); } catch { /* already gone */ }
  };

  const scan = () => {
    try {
      for (const name of nodeFs.readdirSync(dir).filter(n => n.endsWith('.json')).slice(0, MAX_FILES)) handle(name);
    } catch { /* no dir yet */ }
  };

  try { nodeFs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch { /* exists */ }
  scan();
  let watcher = null;
  try {
    watcher = nodeFs.watch(dir, (event, name) => { if (name) handle(String(name)); else scan(); });
    watcher.on?.('error', () => {});
  } catch { /* without fs.watch the startup scan already ran; tools retry with fresh files */ }

  // fs.watch can miss events; a slow rescan catches whatever it dropped (`seen` stops double delivery).
  const sweep = setInterval(scan, 1500);
  sweep.unref?.();

  return { stop() { clearInterval(sweep); try { watcher?.close(); } catch { /* already closed */ } } };
}
