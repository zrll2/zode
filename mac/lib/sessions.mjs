// What ZCode is doing right now, for the tray menu: every live ZCode server keeps a
// ~/.zcode-tap/<pid>.json with { pid, sock, cwd }, and one session/list line per unix socket returns
// its conversations. All best-effort: nothing here throws, a slow or broken server contributes nothing.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { withRealActivity } from '../../relay/activity.mjs';
import { summarizeRequest } from '../../relay/summary.mjs';

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

// Ask one unix socket a question and collect every JSON line until the reply with the expected id
// arrives, it goes quiet, or the timeout passes. Desktop traffic is copied across these sockets too,
// so the caller matches on tapReply + id (default 1, the id every one-shot request here uses).
function defaultConnect(sockPath, request, timeoutMs, replyId = 1) {
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
        try { const o = JSON.parse(line); lines.push(o); if (o && o.tapReply === true && o.id === replyId) return finish(); } catch {}      // the answer is in: stop waiting
      }
    });
    socket.on('error', finish);
    socket.on('close', finish);
  });
}

// Every live server asked in parallel, replies merged and deduped by sessionId (the same session can
// come from several servers; the freshest copy wins, and it remembers which socket it came from, since
// that is the socket its pending requests and its stop/send calls belong to). Resolves [] on any
// failure, never throws, and a server that neither answers nor fails within timeoutMs is skipped.
export async function listSessions({ dir = tapDir(), timeoutMs = 1500, connect = defaultConnect } = {}) {
  try {
    const servers = readTapServers(dir);
    if (servers.length === 0) return [];
    const answers = await Promise.allSettled(servers.map(async server => ({
      server,
      lines: await withDeadline(Promise.resolve().then(() => connect(server.sock, SESSION_REQUEST, timeoutMs)), timeoutMs),
    })));
    const byId = new Map();
    for (const answer of answers) {
      if (answer.status !== 'fulfilled' || !Array.isArray(answer.value.lines)) continue;
      for (const reply of answer.value.lines) {
        if (!reply || typeof reply !== 'object' || reply.tapReply !== true || reply.id !== 1) continue;
        const sessions = reply.result?.sessions;
        if (!Array.isArray(sessions)) continue;
        for (const session of sessions) {
          if (!session || typeof session !== 'object' || session.sessionId == null) continue;
          const kept = byId.get(session.sessionId);
          const at = Number(session.updatedAt) || 0;
          if (!kept || at > kept.at) byId.set(session.sessionId, { at, session: { ...session, sock: answer.value.server.sock } });
        }
      }
    }
    return withRealActivity([...byId.values()].map(kept => kept.session));   // the agent says updatedAt = now for anything it has loaded
  } catch { return []; }
}

// The list never says running mid-turn; the relay's event tracker does. Run the listing through
// relay.liveStatus.apply here (a no-op when the relay is off, never a throw: the list stands on any
// failure), then summarize as usual.
export function withLiveStatus(sessions, liveStatus) {
  if (!Array.isArray(sessions)) return [];
  if (!liveStatus || typeof liveStatus.apply !== 'function') return sessions;
  try {
    const applied = liveStatus.apply(sessions);
    return Array.isArray(applied) ? applied : sessions;
  } catch { return sessions; }
}

// One request over a fresh connection: send one line, take the tap reply that carries our id, close.
// Returns the reply ({ result } or { error }) or null on any failure.
async function ask(sock, method, params, timeoutMs = 1500, connect = defaultConnect) {
  if (!sock || !method) return null;
  try {
    const lines = await withDeadline(
      Promise.resolve().then(() => connect(sock, JSON.stringify({ id: 1, method, params }) + '\n', timeoutMs, 1)), timeoutMs);
    for (const line of Array.isArray(lines) ? lines : []) {
      if (line && typeof line === 'object' && line.tapReply === true && line.id === 1) return line;
    }
  } catch {}
  return null;
}

// Whether a request needs a second look before an allow from the menu bar: the shared classifier
// lives in relay/summary.mjs together with the summariser, imported below.

// The answer options the agent offers with a permission request, kept for the panel's bulk answers:
// only these fields, at most 6, junk ignored. `response` is what ZCode itself sends back when that
// option is chosen — tap/respond gets it verbatim so ZCode records exactly its own rule.
const REQUEST_OPTIONS_MAX = 6;
function permissionOptions(params) {
  const options = [];
  for (const o of Array.isArray(params?.options) ? params.options : []) {
    if (!o || typeof o !== 'object' || Array.isArray(o)) continue;
    if (typeof o.optionId !== 'string' || !o.optionId) continue;
    options.push({
      optionId: o.optionId,
      kind: typeof o.kind === 'string' ? o.kind : '',
      name: typeof o.name === 'string' ? o.name : '',
      response: o.response && typeof o.response === 'object' && !Array.isArray(o.response) ? o.response : null,
    });
    if (options.length >= REQUEST_OPTIONS_MAX) break;
  }
  return options;
}

// "Run: <command>" / "Edit: <file name>" — the tool plus its key input, plus the shared risky
// verdict. The implementation is shared with the relay (relay/summary.mjs); `detail` stays
// untruncated for the confirmation dialog.
export { summarizeRequest } from '../../relay/summary.mjs';

// Every live server asked for its pending permission / user-input requests: oldest first, each
// remembering which socket it came from. Never throws.
export async function listPending({ dir = tapDir(), timeoutMs = 1500, connect = defaultConnect } = {}) {
  try {
    const servers = readTapServers(dir);
    if (servers.length === 0) return [];
    const answers = await Promise.allSettled(servers.map(async server => ({
      server,
      reply: await ask(server.sock, 'tap/pending', {}, timeoutMs, connect),
    })));
    const seen = new Set();
    const requests = [];
    for (const answer of answers) {
      if (answer.status !== 'fulfilled') continue;
      const { server, reply } = answer.value;
      const pending = Array.isArray(reply?.result?.pending) ? reply.result.pending : [];
      for (const entry of pending) {
        if (!entry || typeof entry !== 'object' || entry.id == null) continue;
        const key = `${server.sock}\u0000${entry.id}`;
        if (seen.has(key)) continue;
        const sessionId = entry.params && typeof entry.params === 'object' ? entry.params.sessionId : undefined;
        if (sessionId == null) continue;
        seen.add(key);
        if (entry.method === 'interaction/requestPermission') {
          const summarized = summarizeRequest(entry.params);
          requests.push({
            requestId: entry.id, sessionId, kind: 'permission',
            toolName: typeof entry.params?.toolName === 'string' ? entry.params.toolName : '',
            summary: summarized.text, detail: summarized.detail, risky: summarized.risky === true,
            options: permissionOptions(entry.params),
            command: typeof entry.params?.input?.command === 'string' ? entry.params.input.command.slice(0, 2000) : '',
            sock: server.sock, at: Number(entry.at) || 0,
          });
        } else if (entry.method === 'interaction/requestUserInput') {          // a question: never allow/deny
          requests.push({ requestId: entry.id, sessionId, kind: 'question', toolName: '', summary: '', detail: '', risky: false, sock: server.sock, at: Number(entry.at) || 0 });
        }
      }
    }
    return requests.sort((a, b) => a.at - b.at).map(({ at, ...request }) => request);
  } catch { return []; }
}

// { today, week } from one usage/stats reply, or null when it does not add up: week is
// summary.totalTokens, today the last heatmap day whose date is the Mac's local date (the agent
// reports its days in its own time zone; null day entries are skipped; anything else is today 0).
function usageFrom(result, now) {
  try {
    if (!result || typeof result !== 'object') return null;
    const week = Number(result.summary?.totalTokens);
    if (!Number.isFinite(week) || week < 0) return null;
    const d = now instanceof Date ? now : new Date(now);
    const local = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    let today = 0;
    const weeks = Array.isArray(result.heatmap?.weeks) ? result.heatmap.weeks : [];
    for (const w of weeks) {
      for (const day of Array.isArray(w?.days) ? w.days : []) {
        if (!day || typeof day !== 'object' || day.date !== local) continue;
        const n = Number(day.totalTokens);
        if (Number.isFinite(n) && n >= 0) today = n;                    // the last matching day wins
      }
    }
    return { today, week };
  } catch { return null; }
}

// Token usage for the panel footer: ask every live server usage/stats {range:'7d'} and take the
// first usable reply. Never throws; null when nobody answers within the timeout.
export async function readUsage({ dir = tapDir(), timeoutMs = 4000, connect = defaultConnect, now = new Date() } = {}) {
  try {
    const servers = readTapServers(dir);
    if (servers.length === 0) return null;
    const attempts = servers.map(async server => {
      const reply = await ask(server.sock, 'usage/stats', { range: '7d' }, timeoutMs, connect);
      const usage = usageFrom(reply?.result, now);
      if (!usage) throw new Error('no usable usage');
      return usage;
    });
    return await Promise.any(attempts);
  } catch { return null; }
}

// The plain allow every auto-answering path sends (one place builds it).
export const AUTO_ALLOW_RESULT = Object.freeze({ decision: 'allow', reason: 'Approved automatically by Zode' });

// The permission requests the no-relay fallback answers by itself: only permissions (questions
// always need a human), oldest first, capped like the relay's own bulk answers. With askRisky on,
// the risky ones (the shared classifier's verdict, applied when they were listed) stay for a human.
export function pendingToAutoAllow(list, enabled, askRisky = false) {
  if (enabled !== true) return [];
  const permissions = (Array.isArray(list) ? list : []).filter(r => r && r.kind === 'permission');
  if (askRisky === true) return permissions.filter(r => r.risky !== true).slice(0, 600);
  return permissions.slice(0, 600);
}

// Answer a pending permission request. The first answer wins — a late answer comes back as an error
// and is just as fine — so this resolves to null (any fine outcome) or the server's refusal reason.
// A `response` object (an option's own response from the request) is sent verbatim, so ZCode records
// exactly the rule it offered; otherwise the plain {decision, reason} shape goes out.
export async function respondPermission({ sock, requestId, decision, reason, response, timeoutMs = 1500, connect = defaultConnect } = {}) {
  const result = response && typeof response === 'object' && !Array.isArray(response)
    ? response
    : { decision, ...(reason ? { reason } : {}) };
  const reply = await ask(sock, 'tap/respond', { id: requestId, result }, timeoutMs, connect);
  return reply?.error ? String(reply.error.message ?? 'refused') : null;
}

export async function stopSession({ sock, sessionId, timeoutMs = 1500, connect = defaultConnect } = {}) {
  const reply = await ask(sock, 'session/stop', { sessionId }, timeoutMs, connect);
  return reply?.error ? String(reply.error.message ?? 'refused') : null;
}

export async function sendToSession({ sock, sessionId, content, timeoutMs = 1500, connect = defaultConnect } = {}) {
  const reply = await ask(sock, 'session/send', { sessionId, content }, timeoutMs, connect);
  return reply?.error ? String(reply.error.message ?? 'refused') : null;
}

export const NUDGE_MESSAGE = 'You stopped responding. Continue the task from where you left off. If a command was refused, skip it and use file tools only; reply with the single line the order asked for when done.';
export const RETRY_MESSAGE = 'The last attempt failed. Please try again from where you left off.';

// Nudge a stalled turn: stop it, give the server a moment, then send the continue message.
export async function nudgeSession({ sock, sessionId, timeoutMs = 1500, connect = defaultConnect, waitMs = 1500 } = {}) {
  const stopped = await stopSession({ sock, sessionId, timeoutMs, connect });
  await new Promise(resolve => { const t = setTimeout(resolve, waitMs); t.unref?.(); });
  return await sendToSession({ sock, sessionId, content: NUDGE_MESSAGE, timeoutMs, connect }) ?? stopped;
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
      sessionId: session.sessionId,
      sock: typeof session.sock === 'string' ? session.sock : '',
      group: described.light === 'red' ? 0 : described.light === 'amber' ? 1 : session.status === 'running' ? 2 : 3,
      at: Number(session.updatedAt) || 0,
      liveSince: Number(session.liveSince) || 0,        // when the current run began (the relay's live tracker)
      project: projectName(session),
      status: described.text,
      done: described.done === true,
      older: described.older === true,
      light: described.light,
    });
  }
  rows.sort((a, b) => a.group - b.group || b.at - a.at);
  return {
    lines: rows.slice(0, MAX_LINES).map(({ id, sessionId, sock, project, status, done, older, light, liveSince }) => ({ id, sessionId, sock, project, status, done, older, light, liveSince })),
    more: Math.max(0, rows.length - MAX_LINES),
    finished: rows.filter(r => r.done).length,
    counts,
  };
}
