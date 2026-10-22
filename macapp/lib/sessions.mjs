// What ZCode is doing right now, for the tray menu: every live ZCode server keeps a
// ~/.zcode-tap/<pid>.json with { pid, sock, cwd }, and one session/list line per unix socket returns
// its conversations. All best-effort: nothing here throws, a slow or broken server contributes nothing.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';

const MIN = 60 * 1000;
const tapDir = () => path.join(os.homedir(), '.zcode-tap');
const SESSION_REQUEST = JSON.stringify({ id: 1, method: 'session/list', params: {} }) + '\n';

// The live servers right now: one json file per pid, live while kill(pid, 0) succeeds.
export function readTapServers(dir = tapDir()) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const servers = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    let meta = null;
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { continue; }
    const pid = Number(meta?.pid);
    const sock = typeof meta?.sock === 'string' ? meta.sock : '';
    if (!Number.isInteger(pid) || pid <= 0 || !sock) continue;
    try { process.kill(pid, 0); } catch { continue; }              // the server is gone, the file is stale
    servers.push({ pid, sock, cwd: typeof meta?.cwd === 'string' ? meta.cwd : '' });
  }
  return servers;
}

// Ask one unix socket the session/list question and collect every JSON line until it goes quiet or the
// timeout passes. Desktop traffic is copied across these sockets too, so the caller picks its reply out.
function defaultConnect(sockPath, request, timeoutMs) {
  return new Promise(resolve => {
    const lines = [];
    let buffer = '';
    let socket;
    let settled = false;
    let timer = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { socket?.destroy(); } catch {}
      resolve(lines);
    };
    timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
    try { socket = net.connect(sockPath); } catch { return finish(); }
    socket.setEncoding('utf8');
    socket.on('connect', () => { try { socket.write(request); } catch { finish(); } });
    socket.on('data', chunk => {
      buffer += chunk;
      for (let nl; (nl = buffer.indexOf('\n')) >= 0; buffer = buffer.slice(nl + 1)) {
        const line = buffer.slice(0, nl).trim();
        if (!line) continue;
        try { const o = JSON.parse(line); lines.push(o); if (o && o.tapReply === true && o.id === 1) return finish(); } catch {}      // the answer is in: stop waiting
      }
    });
    socket.on('error', finish);
    socket.on('close', finish);
  });
}

// Every live server asked in parallel, replies merged and deduped by sessionId (the same session can
// come from several servers; the freshest copy wins). Resolves [] on any failure, never throws, and a
// server that neither answers nor fails within timeoutMs is simply skipped.
export async function listSessions({ dir = tapDir(), timeoutMs = 1500, connect = defaultConnect } = {}) {
  try {
    const servers = readTapServers(dir);
    if (servers.length === 0) return [];
    const answers = await Promise.allSettled(servers.map(server =>
      withDeadline(Promise.resolve().then(() => connect(server.sock, SESSION_REQUEST, timeoutMs)), timeoutMs)));
    const byId = new Map();
    for (const answer of answers) {
      if (answer.status !== 'fulfilled' || !Array.isArray(answer.value)) continue;
      for (const reply of answer.value) {
        if (!reply || typeof reply !== 'object' || reply.tapReply !== true || reply.id !== 1) continue;
        const sessions = reply.result?.sessions;
        if (!Array.isArray(sessions)) continue;
        for (const session of sessions) {
          if (!session || typeof session !== 'object' || session.sessionId == null) continue;
          const kept = byId.get(session.sessionId);
          if (!kept || (Number(session.updatedAt) || 0) > (Number(kept.updatedAt) || 0)) byId.set(session.sessionId, session);
        }
      }
    }
    return [...byId.values()];
  } catch { return []; }
}

// The per-server deadline on top of connect's own timeout, so a connect that never settles (tests, odd
// adapters) cannot hold the listing hostage.
function withDeadline(promise, timeoutMs) {
  return new Promise(resolve => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; resolve([]); } }, timeoutMs + 400);   // after connect's own timeout, never before
    timer.unref?.();
    promise.then(
      value => { if (!done) { done = true; clearTimeout(timer); resolve(value); } },
      () => { if (!done) { done = true; clearTimeout(timer); resolve([]); } });
  });
}

// The light and the line for one conversation, or null when it should not be shown at all.
const MAX_LINES = 16;                                              // everything active plus recent finished work, up to this many

export function describeSession(session, now = Date.now()) {
  const status = session?.status;
  const quiet = now - (Number.isFinite(session?.updatedAt) ? session.updatedAt : now);
  if (status === 'error') return { light: 'red', text: 'Failed' };
  if (status === 'waiting') return { light: 'amber', text: 'Waiting for you' };
  if (status === 'running') {
    if (quiet <= 5 * MIN) return { light: 'green', text: 'Working' };
    return { light: 'amber', text: `Quiet for ${Math.floor(quiet / MIN)} min` };   // might be stuck
  }
  if (status === 'idle' && quiet <= 3 * 60 * MIN) {                                   // finished within the last 3 hours
    return quiet < MIN
      ? { light: 'green', text: 'Just now', done: true, older: false }
      : quiet < 60 * MIN
        ? { light: 'green', text: `${Math.floor(quiet / MIN)} min ago`, done: true, older: false }
        : { light: 'green', text: `${Math.floor(quiet / (60 * MIN))} h ago`, done: true, older: true };   // over an hour: the menu folds these by default
  }
  return null;
}

// The project (folder) is what tells two work orders apart; the menu puts the status in its own column.
function projectName(session) {
  const workspacePath = typeof session?.workspace?.workspacePath === 'string' ? session.workspace.workspacePath : '';
  return workspacePath.split('/').filter(Boolean).pop() || 'No workspace';
}

// Everything the tray needs: up to six menu lines (failed, waiting, working, then done, each newest
// first), how many did not fit, and the counts behind the tooltip.
export function summarize(sessions, now = Date.now()) {
  const counts = { working: 0, waiting: 0, failed: 0 };
  const rows = [];
  for (const session of Array.isArray(sessions) ? sessions : []) {
    const described = describeSession(session, now);
    if (!described) continue;
    if (described.light === 'red') counts.failed += 1;
    else if (described.light === 'amber') counts.waiting += 1;        // waiting for you, or maybe stuck
    else if (session.status === 'running') counts.working += 1;
    rows.push({
      id: session.sessionId,
      group: described.light === 'red' ? 0 : described.light === 'amber' ? 1 : session.status === 'running' ? 2 : 3,
      at: Number(session.updatedAt) || 0,
      project: projectName(session),
      status: described.text,
      done: described.done === true,
      older: described.older === true,
      light: described.light,
    });
  }
  rows.sort((a, b) => a.group - b.group || b.at - a.at);
  return {
    lines: rows.slice(0, MAX_LINES).map(({ id, project, status, done, older, light }) => ({ id, project, status, done, older, light })),
    more: Math.max(0, rows.length - MAX_LINES),
    finished: rows.filter(r => r.done).length,
    counts,
  };
}
