// zode-watch: follows Zode's event feed (~/.zode/events.jsonl) from its end and prints one plain
// line per event for Claude Code's Monitor tool to turn into a message. Ships inside Zode.app and
// runs through the app binary with ELECTRON_RUN_AS_NODE=1, so plain Node is all it needs.
//
//   ELECTRON_RUN_AS_NODE=1 "/Applications/Zode.app/Contents/MacOS/Zode" \
//     "/Applications/Zode.app/Contents/Resources/bin/zode-watch.mjs"
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const KINDS = { finished: 'finished', failed: 'failed', needs: 'needs you', stuck: 'stuck' };

// One plain line per event: `finished: <project> - <title> (session <id>)`, the workspace path
// appended in brackets when known. Unknown or junk events print nothing.
export function formatEvent(event) {
  if (!event || typeof event !== 'object') return null;
  const kind = KINDS[event.kind];
  if (!kind) return null;
  const project = typeof event.project === 'string' && event.project ? event.project : 'Zode';
  const title = typeof event.title === 'string' ? event.title.replace(/\s+/g, ' ').trim() : '';
  const session = typeof event.sessionId === 'string' && event.sessionId ? event.sessionId : '?';
  let line = `${kind}: ${project} - ${title || 'ZCode'} (session ${session})`;
  if (typeof event.workspace === 'string' && event.workspace) line += ` [${event.workspace}]`;
  return line;
}

// Follow one file from its END (history is never printed). fs.watch on the directory catches
// writes and rotation; the interval is the fallback. When the file shrinks or its inode changes
// (rotation replaced it), reading restarts from the start of the fresh file. Returns stop().
export function createWatcher(file, { onLine, pollMs = 1000 } = {}) {
  let offset = 0;
  let ino = null;
  let buf = '';
  let stopped = false;
  let watcher = null;
  let timer = null;

  const pump = () => {
    if (stopped) return;
    let st = null;
    try { st = fs.statSync(file); } catch { return; }                 // gone (mid-rotation): the next tick tries again
    if (ino !== null && (st.ino !== ino || st.size < offset)) { offset = 0; buf = ''; }
    ino = st.ino;
    if (st.size <= offset) return;
    let fd;
    let chunk;
    try {
      fd = fs.openSync(file, 'r');
      chunk = Buffer.alloc(st.size - offset);
      fs.readSync(fd, chunk, 0, chunk.length, offset);
      offset += chunk.length;
    } catch {
      return;
    } finally {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
    buf += chunk.toString('utf8');
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';                                          // the last line may still be growing
    for (const l of lines) {
      const t = l.trim();
      if (!t) continue;
      try { onLine(t); } catch { /* a bad line never kills the watcher */ }
    }
  };

  const start = () => {
    try { const st = fs.statSync(file); ino = st.ino; offset = st.size; } catch { offset = 0; ino = null; }
    timer = setInterval(pump, pollMs);
    timer.unref?.();
    try {
      watcher = fs.watch(path.dirname(file), () => pump());
      watcher.on?.('error', () => {});
    } catch { /* the poll fallback carries it */ }
  };

  const stop = () => {
    stopped = true;
    try { watcher?.close(); } catch { /* already closed */ }
    if (timer) clearInterval(timer);
  };

  start();
  return stop;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const file = path.join(os.homedir(), '.zode', 'events.jsonl');
  console.log('watching Zode events');
  const stop = createWatcher(file, {
    onLine: (raw) => {
      let event;
      try { event = JSON.parse(raw); } catch { return; }
      const line = formatEvent(event);
      if (line) console.log(line);                                    // flushed with the write; never buffered
    },
  });
  const quit = () => { stop(); process.exit(0); };
  process.on('SIGTERM', quit);
  process.on('SIGINT', quit);
  process.stdin.on('end', quit);                                      // Claude Code closes the pipe when done
  process.stdin.resume();
}
