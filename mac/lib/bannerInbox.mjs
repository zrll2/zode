// The banner inbox: other tools drop one small JSON file per macOS banner into ~/.zode/banners/
// (`{ title, body, sound? }`) and Zode shows it through the app's own Notification, so banners
// carry Zode's logo instead of the Script Editor icon. The folder stays empty: every file is
// delivered or deleted, and nothing but the parsed title/body/sound survives.
import fs from 'node:fs';
import path from 'node:path';

const MAX_AGE_MS = 120_000;
const MAX_FILES = 50;

// text -> { title, body, sound } | null. Valid when the JSON is an object with a non-empty title
// or body; strings are trimmed and capped (80/200); sound is true only when explicitly true.
// Stale drops (older than 120 s), non-JSON text and non-objects are null. Never throws.
export function parseBanner(text, ageMs) {
  try {
    if (typeof text !== 'string') return null;
    if (!Number.isFinite(ageMs) || ageMs > MAX_AGE_MS) return null;
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const title = typeof parsed.title === 'string' ? parsed.title.trim().slice(0, 80) : '';
    const body = typeof parsed.body === 'string' ? parsed.body.trim().slice(0, 200) : '';
    if (!title && !body) return null;
    return { title, body, sound: parsed.sound === true };
  } catch {
    return null;
  }
}

// Watch the drop folder. Every existing *.json is processed once, then fs.watch picks up new ones
// (the scan cap keeps a flooded folder from wedging the startup). Each file is read, parsed with
// its mtime age, delivered when valid, and deleted either way. Never throws.
export function startBannerInbox({ dir, onBanner, fs: nodeFs = fs, now = Date.now } = {}) {
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
    let banner = null;
    try { banner = parseBanner(text, now() - mtimeMs); } catch { banner = null; }
    if (banner) {
      try { onBanner(banner); } catch { /* the banner is still consumed */ }
    }
    try { nodeFs.unlinkSync(file); } catch { /* already gone */ }
  };

  const scan = () => {
    try {
      for (const name of nodeFs.readdirSync(dir).filter(n => n.endsWith('.json')).slice(0, MAX_FILES)) handle(name);
    } catch { /* no dir yet */ }
  };

  try { nodeFs.mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
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
