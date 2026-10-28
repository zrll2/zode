// zode-relay service: the phone relay as a startable module. Zode.app embeds this; relay.mjs is a thin CLI over it.
// Upstream : unix sockets from Zode.app (~/.zcode-tap/*.json), one per workspace server.
// Downstream: paired phones over WebSocket. Pair and revoke through createPairing() / revokeDevice().
// Transport security is the network's job: bind to a Tailscale/WireGuard address. Default is 127.0.0.1.
import { withRealActivity } from './activity.mjs';
import { createLiveStatus } from './live.mjs';
import { isRiskyRequest } from './risk.mjs';
import { summarizeRequest } from './summary.mjs';
import { createPusher } from './push.mjs';
import { validateTranscribe, createLimiter } from './stt.mjs';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';

const HOME = os.homedir();
const CODE_TTL_MS = 5 * 60 * 1000;
const REPLAY_MAX = 5000;
const STATUS_DEBOUNCE_MS = 250;
const RPC_TIMEOUT_MS = 30_000;            // one deadline for every request that waits on an upstream, the relay's or a phone's
// iOS closes a WebSocket on a frame above 1 MiB (URLSessionWebSocketTask default). Keep every frame well below that.
const MAX_FRAME = 800_000;

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { fs.writeFileSync(f, JSON.stringify(v, null, 1), { mode: 0o600 }); fs.chmodSync(f, 0o600); };
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const eq = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };

// ---- policy: what a phone may call ------------------------------------------
const ALLOWED = new Set(['session/list', 'session/create', 'session/resume', 'session/read', 'session/messages', 'session/events',
  'session/subscribe', 'session/send', 'session/stop', 'session/close', 'session/setModel', 'session/setThoughtLevel', 'session/setMode',
  'session/usage', 'session/goal', 'session/compact', 'session/rename', 'usage/stats', 'attachment/upload',
  // stt/* are answered by the relay itself (never forwarded); the handler validates their params and
  // answers failures with its own -32020 codes, so checkPolicy has nothing more to say about them.
  'stt/transcribe', 'stt/status',
  // push/* are answered by the relay itself too: the phone stores its push endpoint on its own
  // device record. Validated in checkPolicy; a phone without a pairing key gets -32021.
  'push/register', 'push/unregister']);
const SAFE_MODES = new Set(['plan', 'edit', 'guarded']);       // never yolo / build from a phone
const DECISIONS = new Set(['allow', 'deny']);   // a phone may only allow or deny; never modify, escalate or add rules
// session/rename and session/send (with attachments) are the phone methods that become agent commands: the relay builds
// the whole v4/command envelope itself, so a phone can never send v4/command or inject fields into it.
const COMMANDS = {
  'session/rename': { verb: 'rename', type: 'renameSession', payload: p => ({ title: p.title.trim() }) },
};
const MAX_UPLOAD = 8 * 1024 * 1024;            // largest file a phone may attach
const CHUNK = 256 * 1024;                      // the agent stages uploads in chunks of at most 256 KiB
const MIME_RE = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const b64Bytes = s => Math.floor(s.length / 4) * 3 - (s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0);   // decoded size, no decode
const ATTACH_FIELDS = a => ({ ref: a.ref, fileName: a.fileName, mime: a.mime, bytes: a.bytes });         // drop anything else the phone sent

// The agent stages files under the name a phone sends, so a file name is only ever one path
// component: the basename after / or \, control characters dropped, trimmed, at most 200
// characters. Null when nothing safe remains ('', '.', '..', separators only) — callers refuse.
function safeFileName(name) {
  if (typeof name !== 'string') return null;
  const base = name.split(/[\\/]/).pop().replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 200);
  return base && base !== '.' && base !== '..' ? base : null;
}

function checkAttachment(a, sessionId) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return 'each attachment must be an object';
  if (typeof a.ref !== 'string' || !a.ref.startsWith(`zcode-artifact://${sessionId}/`)) return 'attachment ref must be a zcode-artifact:// ref of this session';
  if (typeof a.fileName !== 'string' || !a.fileName.length || a.fileName.length > 200) return 'attachment fileName must be 1-200 characters';
  if (!safeFileName(a.fileName)) return 'attachment fileName must reduce to a safe file name';
  if (typeof a.mime !== 'string' || a.mime.length > 100 || !MIME_RE.test(a.mime)) return 'attachment mime must be a lowercase type/subtype';
  if (!Number.isInteger(a.bytes) || a.bytes < 1 || a.bytes > MAX_UPLOAD) return 'attachment bytes must be 1 byte to 8 MB';
  return null;
}

export function checkPolicy(method, params) {
  if (!ALLOWED.has(method)) return `method not allowed: ${method}`;
  const mode = method === 'session/create' ? params?.mode : method === 'session/setMode' ? (params?.mode ?? params?.current) : undefined;
  if (method === 'session/create' && mode === undefined) return 'mode required (plan|edit|guarded)';
  if (mode !== undefined && !SAFE_MODES.has(mode)) return `mode not allowed from mobile: ${mode}`;
  if (method === 'session/rename' || method === 'attachment/upload') {
    const id = params?.sessionId;
    if (typeof id !== 'string' || !id.startsWith('sess_') || id.length > 100) return 'sessionId must be a sess_ id of at most 100 characters';
  }
  if (method === 'session/rename') {
    const title = typeof params?.title === 'string' ? params.title.trim() : '';
    if (!title || title.length > 120) return 'title must trim to 1-120 characters';
  }
  if (method === 'attachment/upload') {
    const name = params?.fileName;
    if (typeof name !== 'string' || !name.length || name.length > 200) return 'fileName must be 1-200 characters';
    if (!safeFileName(name)) return 'fileName must reduce to a safe file name';
    const mime = params?.mime;
    if (typeof mime !== 'string' || mime.length > 100 || !MIME_RE.test(mime)) return 'mime must be a lowercase type/subtype';
    const b64 = params?.dataBase64;
    if (typeof b64 !== 'string' || !B64_RE.test(b64) || b64.length % 4) return 'dataBase64 must be base64';
    const bytes = b64Bytes(b64);
    if (bytes < 1) return 'file is empty';
    if (bytes > MAX_UPLOAD) return 'file is larger than 8 MB';
  }
  if (method === 'session/send' && Array.isArray(params?.attachments) && params.attachments.length) {
    if (params.attachments.length > 6) return 'at most 6 attachments';
    for (const a of params.attachments) { const bad = checkAttachment(a, params?.sessionId); if (bad) return bad; }
    if (typeof params.content !== 'string') return 'content must be a string when attachments are sent';
  }
  if (method === 'usage/stats' && !['all', '7d', '30d'].includes(params?.range)) return "range must be 'all', '7d' or '30d'";
  if (method === 'push/register') {
    const b64 = (v, min, max) => typeof v === 'string' && v.length >= min && v.length <= max && /^[A-Za-z0-9_-]+$/.test(v);
    if (!b64(params?.pushId, 20, 2000)) return 'pushId must be 20-2000 base64url characters';
    if (!b64(params?.secret, 20, 200)) return 'secret must be 20-200 base64url characters';
    if (params?.env !== 'production' && params?.env !== 'sandbox') return "env must be 'production' or 'sandbox'";
    return null;
  }
  if (method === 'push/unregister') return null;
  return null;
}

// Bumped when the phone can rely on new relay methods. 2 = rename, usage/stats, attachments, send with attachments.
// The speech engine rides alongside without a bump: the phone reads features.stt from the ready frame.
export const PROTOCOL = 2;

export function createRelay(opts = {}) {
  const port = Number(opts.port || 8787);
  // One relay, every way in: one http listener per host, all on the same port. `host` still works as
  // a one-element `hosts`. The wildcard is never bound; loopback only when it is the only host left.
  const raw = (Array.isArray(opts.hosts) && opts.hosts.length ? opts.hosts : [opts.host || '127.0.0.1']).filter(h => typeof h === 'string' && h !== '');
  let hosts = [...new Set(raw.filter(h => h !== '0.0.0.0'))];
  if (hosts.length > 1) hosts = hosts.filter(h => h !== '127.0.0.1');
  if (hosts.length === 0) hosts = ['127.0.0.1'];
  const givenUrls = Array.isArray(opts.publicUrls) ? opts.publicUrls.filter(u => typeof u === 'string' && u) : [];
  const publicUrls = givenUrls.length ? givenUrls
    : (typeof opts.publicUrl === 'string' && opts.publicUrl ? [opts.publicUrl] : hosts.map(h => `ws://${h}:${port}`));
  const publicUrl = publicUrls[0];
  const stateDir = opts.stateDir || path.join(HOME, '.zode', 'relay');
  const tapDir = opts.tapDir || path.join(HOME, '.zcode-tap');
  const codeTtlMs = opts.codeTtlMs ?? CODE_TTL_MS;
  const pendingSyncMs = Number.isFinite(opts.pendingSyncMs) ? Math.max(0, opts.pendingSyncMs) : 10_000;   // how often the pending list is reconciled with the wrapper's truth; 0 disables
  const autoAllow = typeof opts.autoAllow === 'function' ? opts.autoAllow : () => false;   // the host decides; the relay on its own never answers
  const askRisky = typeof opts.askRisky === 'function' ? opts.askRisky : () => false;      // true: risky commands wait for a human even with auto-allow on
  // Push: a pusher (relay/push.mjs) forwarded to the host, `push: false` to switch pushes off, or
  // the default real pusher on the global fetch. pushDelayMs is how long a pending request waits
  // before its push goes out — a desktop answer or an auto-allow inside that window cancels it.
  const pusher = opts.push === false ? null : (opts.push || createPusher({ log: (...a) => log.log(...a), now: Date.now }));
  const pushDelayMs = Number.isFinite(opts.pushDelayMs) ? Math.max(0, opts.pushDelayMs) : 1500;
  const rpcTimeoutMs = Number.isFinite(opts.rpcTimeoutMs) ? Math.max(1, opts.rpcTimeoutMs) : RPC_TIMEOUT_MS;   // tests shorten it; the deadline stays one for everything
  const log = opts.log ?? console;
  const stt = opts.stt ?? null;               // the host's speech engine ({transcribe, status, defaultLanguage}); absent -> voice-off
  const sttLimiter = createLimiter();         // per device: one transcribe in flight, at most 20 per minute
  const DEVICES = path.join(stateDir, 'devices.json');
  const CODES = path.join(stateDir, 'pair-codes.json');

  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });

  // ---- per-relay state (two relays in one process share nothing) ---------------
  const upstream = new Map();         // pid -> {meta, sock, buf}
  const routes = new Map();           // relay request id -> {client, clientId, pid}
  const replay = [];                  // [{seq, server, msg}]
  const clients = new Set();
  const pendingReq = new Map();      // `${pid}:${id}` -> {server, id, method, params, at}  (permission / user-input requests waiting for an answer)
  const listeners = new Map();        // event -> Set<fn>
  let relayId = 0, seq = 0;
  let servers = [], wss = null, syncTimer = null, statusTimer = null, pendingTimer = null;
  let running = false;

  // What is really running, from the event stream the servers already send: session/list keeps
  // saying 'idle' mid-turn, so every upstream line feeds this tracker, every session/list reply to a
  // phone carries its verdict, and the host reads the same truth through relay.liveStatus.
  const live = createLiveStatus();
  const syncPending = () => live.setPending([...pendingReq.values()].map(p => ({ sessionId: p.params?.sessionId, method: p.method })));
  const autoAnswered = new Set();     // `${pid}:${id}` this relay already answered itself: never twice, never re-added
  const pendingPushSeen = new Set();  // `${pid}:${id}` requests that already scheduled their push: once per request id
  const pendingPushTimers = new Map();

  function status() {
    return { running, host: hosts[0], hosts: [...hosts], port, publicUrl, publicUrls: [...publicUrls], upstreams: upstream.size, clients: clients.size, devices: readJson(DEVICES, []).length };
  }
  function emitStatus() {             // at most one 'status' per STATUS_DEBOUNCE_MS
    if (statusTimer) return;
    statusTimer = setTimeout(() => {
      statusTimer = null;
      for (const fn of [...(listeners.get('status') ?? [])]) { try { fn(status()); } catch (e) { log.error?.(e); } }
    }, STATUS_DEBOUNCE_MS);
    statusTimer.unref?.();
  }
  function on(event, fn) { let s = listeners.get(event); if (!s) listeners.set(event, s = new Set()); s.add(fn); }
  function off(event, fn) { listeners.get(event)?.delete(fn); }

  // ---- upstream (tap) ---------------------------------------------------------
  function livePids() {
    let metas = [];
    try { metas = fs.readdirSync(tapDir).filter(f => f.endsWith('.json')).map(f => readJson(path.join(tapDir, f))); } catch {}
    return metas.filter(m => { try { process.kill(m.pid, 0); return true; } catch { return false; } });
  }
  function syncUpstream() {
    const live = new Map(livePids().map(m => [m.pid, m]));
    for (const [pid, u] of upstream) if (!live.has(pid)) { u.sock.destroy(); upstream.delete(pid); emitStatus(); }
    for (const [pid, meta] of live) {
      if (upstream.has(pid)) continue;
      const sock = net.connect(meta.sock); const u = { meta, sock, buf: '' }; upstream.set(pid, u); emitStatus();
      sock.on('data', d => { u.buf += d; let i; while ((i = u.buf.indexOf('\n')) >= 0) { const l = u.buf.slice(0, i); u.buf = u.buf.slice(i + 1); if (l.trim()) fromUpstream(pid, l).catch(() => {}); } });
      sock.on('close', () => {
        upstream.delete(pid); emitStatus();
        for (const k of pendingReq.keys()) if (k.startsWith(pid + ':')) pendingReq.delete(k);
        for (const k of autoAnswered) if (k.startsWith(pid + ':')) autoAnswered.delete(k);
        for (const k of [...pendingPushSeen]) if (k.startsWith(pid + ':')) pendingPushSeen.delete(k);
        for (const [k, t] of pendingPushTimers) if (k.startsWith(pid + ':')) { clearTimeout(t); pendingPushTimers.delete(k); }
        syncPending();
        for (const [rid, r] of routes) if (r.pid === pid) {              // every route waiting on this upstream dies with it
          routes.delete(rid); clearTimeout(r.timer);
          if (r.internalCall) r.reject(new Error('upstream closed'));
          else if (r.client) send(r.client, { type: 'rpc-result', id: r.clientId, server: pid, error: { code: -32013, message: 'the ZCode server closed before answering' } });
        }
      });
      sock.on('error', () => {});
      const sid = ++relayId; routes.set(sid, { internal: true, pid });       // ask the wrapper what is already pending
      sock.write(JSON.stringify({ id: sid, method: 'tap/pending', params: {} }) + '\n');
    }
  }

  // Ask one server what it still holds as pending — the same internal round-trip the first sync uses.
  function requestPending(pid) {
    const u = upstream.get(pid);
    if (!u) return;
    const id = ++relayId;
    routes.set(id, { internal: true, pid });
    try { u.sock.write(JSON.stringify({ id, method: 'tap/pending', params: {} }) + '\n'); } catch {}
  }

  // Auto-allow, when the host turned it on: answer a permission request the moment the relay knows
  // it and strike it from the pending list (the wrapper's tap/resolved follows anyway). Questions
  // are never answered here — they need a human. One answer per request even if a reconcile lists
  // it again; a failed write leaves the request pending, as if the setting were off.
  function autoAllowRequest(pid, entry) {
    if (!entry || typeof entry !== 'object' || entry.method !== 'interaction/requestPermission' || entry.id == null) return;
    let wanted = false;
    try { wanted = autoAllow() === true; } catch { wanted = false; }
    if (!wanted) return;
    let careful = false;
    try { careful = askRisky() === true; } catch { careful = false; }
    if (careful && isRiskyRequest(entry.params)) return;              // the destructive ones wait for a human
    const key = `${pid}:${entry.id}`;
    if (autoAnswered.has(key)) return;
    const u = upstream.get(pid);
    if (!u) return;
    try {
      u.sock.write(JSON.stringify({ id: ++relayId, method: 'tap/respond', params: { id: entry.id, result: { decision: 'allow', reason: 'Approved automatically by Zode' } } }) + '\n');
    } catch { return; }
    autoAnswered.add(key);
    pendingReq.delete(key);
    log.log(`auto-allowed ${typeof entry.params?.toolName === 'string' && entry.params.toolName ? entry.params.toolName : 'request'} -> ${pid}`);
  }

  // The wrapper's own pending list is the truth: events go stale when a turn is stopped or cancelled
  // and its request vanishes without a tap/resolved. Add what the reply lists and the relay does not
  // know yet, drop what vanished — but only requests old enough that they cannot have arrived while
  // the question was in flight (5 s) — then tell the running tracker. Never throws; a missing or
  // garbled reply changes nothing.
  function reconcilePending(pid, pending) {
    try {
      if (!Array.isArray(pending)) return;
      const now = Date.now();
      const listed = new Set();
      for (const p of pending) {
        if (!p || typeof p !== 'object' || p.id == null) continue;
        const key = `${pid}:${p.id}`;
        listed.add(String(p.id));
        if (pendingReq.has(key) || autoAnswered.has(key)) continue;     // known, or already answered by us
        pendingReq.set(key, { server: pid, ...p, seenAt: now });
        autoAllowRequest(pid, p);                                       // may answer and remove it again
      }
      const cutoff = now - 5_000;
      for (const [key, p] of pendingReq) {
        if (p.server !== pid || listed.has(String(key.slice(String(pid).length + 1)))) continue;
        const at = Number.isFinite(p.at) && p.at > 1e12 ? p.at : p.seenAt ?? now;   // when the request really became known
        if (at < cutoff) pendingReq.delete(key);
      }
      syncPending();
    } catch { /* the next round tries again */ }
  }

  async function fromUpstream(pid, line) {
    let m; try { m = JSON.parse(line); } catch { return; }
    live.observe(m);                                                // every line feeds the running tracker; it ignores what is not session traffic
    if (m.id !== undefined && !m.method) {                          // reply
      if (!m.tapReply) return;                                      // copy of a desktop reply
      const r = routes.get(m.id); if (!r) return; routes.delete(m.id);
      if (r.internal) { reconcilePending(r.pid, m.result?.pending); return; }
      if (r.internalCall) {
        clearTimeout(r.timer);
        const err = m.error ?? (m.result?.status === 'rejected' ? m.result : m.result?.error);
        if (err) return r.reject(new Error(err.message ?? err.reasonCode ?? (typeof err === 'string' ? err : 'upstream error')));
        return r.resolve(m.result);
      }
      delete m.tapReply; m.id = r.clientId;
      // The agent reports updatedAt = now for every conversation it has loaded; ZCode's database has the real time.
      if (r.method === 'session/list' && Array.isArray(m.result?.sessions)) {
        m.result.sessions = await withRealActivity(m.result.sessions);   // async: a slow database waits off the event loop, the stream keeps moving
        m.result.sessions = live.apply(m.result.sessions);          // the live verdict wins, after the real times
      }
      return send(r.client, { type: 'rpc-result', server: pid, ...fitForMobile(r.method, m) });
    }
    if (m.method === 'startup/storageState' || m.method === 'process/mcpTelemetry' || m.method?.startsWith('v4/telemetry')) return;
    if (m.method && m.id !== undefined && /^interaction\/request(Permission|UserInput)$/.test(m.method)) {
      const now = Date.now();
      if (!autoAnswered.has(`${pid}:${m.id}`)) {                        // an already-answered repeat stays out
        pendingReq.set(`${pid}:${m.id}`, { server: pid, id: m.id, method: m.method, params: m.params, at: now, seenAt: now });
        autoAllowRequest(pid, m);                                       // may answer and remove it again
        if (pendingReq.has(`${pid}:${m.id}`)) schedulePendingPush(pid, m);   // still pending: the phone hears about it
      }
      syncPending();
    }
    if (m.method === 'tap/resolved') {
      const key = `${pid}:${m.params?.id}`;
      pendingPushSeen.delete(key);                                      // answered: the scheduled push cancels itself
      const timer = pendingPushTimers.get(key);
      if (timer) { clearTimeout(timer); pendingPushTimers.delete(key); }
      pendingReq.delete(key); syncPending();
    }
    const e = { seq: ++seq, server: pid, msg: m };
    replay.push(e); if (replay.length > REPLAY_MAX) replay.shift();
    for (const c of clients) if (c.authed) send(c, JSON.stringify(e).length > MAX_FRAME ? { type: 'event', seq: e.seq, server: pid, msg: { method: m.method, params: { sessionId: m.params?.sessionId, type: m.params?.type, truncated: true } } } : { type: 'event', ...e });
  }
  function fitForMobile(method, m) {
    if (method === 'session/resume' && Array.isArray(m.result?.messages)) {      // the phone loads history with session/messages
      m.result = { ...m.result, messagesOmitted: m.result.messages.length, messages: [] };
    }
    if (method === 'session/messages' && Array.isArray(m.result?.messages)) {    // drop the oldest messages until the frame fits
      let dropped = 0;
      while (m.result.messages.length > 1 && JSON.stringify(m).length > MAX_FRAME) { m.result.messages.shift(); dropped++; }
      if (dropped) m.result.truncated = { droppedOldest: dropped };
    }
    if (JSON.stringify(m).length > MAX_FRAME) return { id: m.id, error: { code: -32012, message: 'response too large for mobile; request less data' } };
    return m;
  }
  const send = (c, o) => { try { if (c.ws.readyState === 1) c.ws.send(JSON.stringify(o)); } catch {} };

  // One relay-built request to one upstream; the reply comes back through fromUpstream (tapReply convention) and the
  // promise settles with the agent's result or an Error carrying its message / reasonCode. 30 s per call.
  function callUpstream(u, method, params) {
    return new Promise((resolve, reject) => {
      const id = ++relayId;
      const timer = setTimeout(() => { if (routes.delete(id)) reject(new Error(`${method} timed out`)); }, rpcTimeoutMs);
      timer.unref?.();
      routes.set(id, { internalCall: true, pid: u.meta.pid, resolve, reject, timer });
      try { u.sock.write(JSON.stringify({ id, method, params }) + '\n'); }
      catch (err) { clearTimeout(timer); routes.delete(id); reject(err); }
    });
  }

  // A phone-facing request gets the same deadline as the relay's internal calls: when the timer fires —
  // or the upstream closes first — the phone gets one clear error and the route dies.
  function clientRoute(c, clientId, pid, method) {
    const id = ++relayId;
    const timer = setTimeout(() => {
      if (routes.delete(id)) send(c, { type: 'rpc-result', id: clientId, server: pid, error: { code: -32013, message: 'the request timed out upstream' } });
    }, rpcTimeoutMs);
    timer.unref?.();
    routes.set(id, { client: c, clientId, pid, method, timer });
    return id;
  }

  // ---- pairing / devices -------------------------------------------------------
  function newPairCode() {
    const code = crypto.randomBytes(4).toString('hex').toUpperCase();
    const expiresAt = Date.now() + codeTtlMs;
    const all = readJson(CODES, {}); for (const k of Object.keys(all)) if (all[k] < Date.now()) delete all[k];
    all[sha(code)] = expiresAt; writeJson(CODES, all);
    return { code, expiresAt };
  }
  function redeem(code, name) {
    const all = readJson(CODES, {}); const k = sha(String(code || '').toUpperCase());
    const exp = all[k]; if (!exp || exp < Date.now()) return null;
    delete all[k]; writeJson(CODES, all);                           // one-time
    const token = crypto.randomBytes(32).toString('base64url'); const id = crypto.randomBytes(4).toString('hex');
    const pushKey = crypto.randomBytes(32).toString('base64url');    // seals notifications for this phone; rotated by re-pairing
    const devs = readJson(DEVICES, []); devs.push({ id, name: String(name || 'phone').slice(0, 60), tokenHash: sha(token), pairedAt: Date.now(), pushKey });
    writeJson(DEVICES, devs); emitStatus();
    return { id, token, pushKey };
  }
  const findDevice = token => readJson(DEVICES, []).find(d => eq(d.tokenHash, sha(String(token))));

  function createPairing(over = {}) {
    const first = typeof over.publicUrl === 'string' && over.publicUrl ? over.publicUrl : publicUrl;
    const urls = over.publicUrl ? [first, ...publicUrls.filter(u => u !== first)] : [...publicUrls];
    const { code, expiresAt } = newPairCode();
    // Old phones read u (the http form of the first address) and w; newer ones read every ws url.
    const payload = JSON.stringify({ u: first.replace(/^ws/, 'http'), urls, w: first, c: code });
    return { code, expiresAt, publicUrl: first, publicUrls: urls, payload };
  }
  function listDevices() {
    const live = new Set();
    for (const c of clients) if (c.authed && c.device && c.device.id != null) live.add(c.device.id);
    return readJson(DEVICES, []).map(({ id, name, pairedAt }) => ({ id, name, pairedAt, connected: live.has(id) }));
  }
  function revokeDevice(id) {
    const devs = readJson(DEVICES, []); const next = devs.filter(d => d.id !== id);
    if (next.length === devs.length) return false;
    writeJson(DEVICES, next);
    for (const c of [...clients]) if (c.device?.id === id) { try { c.ws.close(4004, 'device revoked'); } catch {} }
    emitStatus();
    return true;
  }

  // ---- phone-initiated uploads and commands ---------------------------------------

  // attachment/upload: resume the session, stage the file in chunks, commit. Answers {ref, fileName, mime, bytes}.
  async function uploadAttachment(c, m, u) {
    const p = m.params;
    const connectionId = `relay-${c.device.id}`;
    const uploadId = crypto.randomUUID();
    const fail = message => send(c, { type: 'rpc-result', id: m.id, error: { code: -32010, message } });
    try {
      const raw = Buffer.from(p.dataBase64, 'base64');
      const fileName = safeFileName(p.fileName);                           // one safe basename, the same rule the send path applies
      if (!fileName) return fail('upload failed: the file name is not safe');
      log.log(`upload ${c.device.id} ${fileName} ${raw.length}B -> ${u.meta.pid}`);
      await callUpstream(u, 'session/resume', { sessionId: p.sessionId });
      await callUpstream(u, 'v4/attachment/begin', { connectionId, uploadId, sessionId: p.sessionId, fileName, mime: p.mime,
        totalBytes: raw.length, totalChunks: Math.ceil(raw.length / CHUNK), checksum: 'sha256:' + crypto.createHash('sha256').update(raw).digest('hex') });
      for (let i = 0; i * CHUNK < raw.length; i++) {
        await callUpstream(u, 'v4/attachment/chunk', { connectionId, uploadId, sessionId: p.sessionId, chunkIndex: i, dataBase64: raw.subarray(i * CHUNK, (i + 1) * CHUNK).toString('base64') });
      }
      const done = await callUpstream(u, 'v4/attachment/commit', { connectionId, uploadId, sessionId: p.sessionId });
      if (!done?.ref) return fail('upload failed: the commit returned no ref');
      send(c, { type: 'rpc-result', id: m.id, result: { ref: done.ref, fileName, mime: p.mime, bytes: raw.length } });
    } catch (err) {
      callUpstream(u, 'v4/attachment/abort', { connectionId, uploadId, sessionId: p.sessionId }).catch(() => {});   // its params are undocumented: best effort
      fail(`upload failed: ${err.message}`);
    }
  }

  // session/send with attachments: resume, then one relay-built sendText command.
  async function sendWithAttachments(c, m, u) {
    const p = m.params;
    const fail = message => send(c, { type: 'rpc-result', id: m.id, error: { code: -32010, message } });
    try {
      log.log(`send ${c.device.id} ${p.attachments.length} attachment(s) -> ${u.meta.pid}`);
      await callUpstream(u, 'session/resume', { sessionId: p.sessionId });
      const attachments = p.attachments.map((a) => ({ ...ATTACH_FIELDS(a), fileName: safeFileName(a.fileName) }));   // never the phone's raw name
      if (attachments.some((a) => !a.fileName)) return fail('send failed: an attachment file name is not safe');
      const payload = { text: p.content, attachments };
      if (p.modelSelection !== undefined) payload.modelSelection = p.modelSelection;
      const res = await callUpstream(u, 'v4/command', { commandId: crypto.randomUUID(), clientId: 'zode-relay', sessionId: p.sessionId, type: 'sendText', payload, issuedAt: Date.now() });
      if (!res || res.status !== 'accepted') return fail(res?.reasonCode ?? 'send was not accepted');
      send(c, { type: 'rpc-result', id: m.id, result: { accepted: true, sessionId: p.sessionId, command: res } });
    } catch (err) { fail(err.message); }
  }

  // stt/transcribe and stt/status: answered here from the host-provided engine, never forwarded
  // upstream (no ZCode server needed). Failures are rpc errors with code -32020 and the reason in
  // data.reason — the engine's own code, or the relay's bad-params / too-large / rate-limited / voice-off.
  const sttFail = (c, m, reason, message) => send(c, { type: 'rpc-result', id: m.id, error: { code: -32020, message, data: { reason } } });
  async function handleStt(c, m) {
    if (!stt) return sttFail(c, m, 'voice-off', 'this relay has no speech engine');
    if (m.method === 'stt/status') {
      let s = null;
      try { s = await stt.status(); } catch (err) { return sttFail(c, m, 'engine-failed', err?.message ?? String(err)); }
      let language = 'en';
      try { language = stt.defaultLanguage?.() ?? 'en'; } catch { /* keep 'en' */ }
      const small = s?.models?.small ?? null;
      return send(c, { type: 'rpc-result', id: m.id, result: {
        available: s?.engine === true && small?.state === 'ready',
        language, model: 'small', modelState: small?.state ?? 'missing',
      } });
    }
    const v = validateTranscribe(m.params);
    if (!v.ok) return sttFail(c, m, v.reason, v.message);
    if (!sttLimiter.take(c.device.id)) return sttFail(c, m, 'rate-limited', 'one transcription at a time, at most 20 per minute');
    const startedAt = Date.now();
    let line = null;
    try {
      const res = await stt.transcribe({ audio: v.value.audio, format: v.value.format, language: v.value.language, hint: { projects: v.value.projects, titles: v.value.titles } });
      if (res?.ok) {
        line = `stt ${c.device.id} ${v.value.audio.length}B lang=${res.language} ${res.ms}ms ok`;   // never the transcript
        return send(c, { type: 'rpc-result', id: m.id, result: { ok: true, text: res.text, ms: res.ms, language: res.language } });
      }
      const reason = res?.code ?? 'engine-failed';
      line = `stt ${c.device.id} ${v.value.audio.length}B lang=${v.value.language ?? '-'} ${Date.now() - startedAt}ms failed (${reason})`;
      return sttFail(c, m, reason, res?.error ?? 'transcription failed');
    } catch (err) {
      line = `stt ${c.device.id} ${v.value.audio.length}B lang=${v.value.language ?? '-'} ${Date.now() - startedAt}ms failed (engine-failed)`;
      return sttFail(c, m, 'engine-failed', err?.message ?? String(err));
    } finally {
      sttLimiter.release(c.device.id);
      if (line) log.log(line);
    }
  }

  // push/register and push/unregister: the phone stores (or clears) its push-service endpoint on its
  // own device record. A phone paired before push existed has no key: it re-pairs to get one.
  function handlePushRpc(c, m) {
    const fail = (message) => send(c, { type: 'rpc-result', id: m.id, error: { code: -32021, message } });
    const devs = readJson(DEVICES, []);
    const at = devs.findIndex((d) => d.id === c.device?.id);
    if (at < 0 || !c.device?.pushKey) return fail('no-push-key: pair again to get one');
    if (m.method === 'push/register') {
      devs[at].push = { pushId: m.params.pushId, secret: m.params.secret, env: m.params.env, at: Date.now() };
    } else {
      delete devs[at].push;
    }
    writeJson(DEVICES, devs);
    c.device = devs[at];
    send(c, { type: 'rpc-result', id: m.id, result: { ok: true } });
  }

  const projectNameOf = (pid) => {
    const cwd = upstream.get(pid)?.meta?.cwd;                          // the server's folder is the project name
    const parts = typeof cwd === 'string' ? cwd.split('/').filter(Boolean) : [];
    return parts[parts.length - 1] || 'Zode';
  };

  // A pending permission or question pushes to the phone shortly after it arrives — but only if it
  // is still pending when the moment comes (a quick desktop answer or auto-allow cancels it), and
  // only once per request id. The title is the project, the body the same summary the Mac shows.
  function schedulePendingPush(pid, entry) {
    if (!pusher) return;
    const key = `${pid}:${entry.id}`;
    if (pendingPushSeen.has(key)) return;
    pendingPushSeen.add(key);
    const timer = setTimeout(() => {
      pendingPushTimers.delete(key);
      try {
        const still = pendingReq.get(key);
        if (!still) return;
        const question = still.method === 'interaction/requestUserInput';
        notifyDevices({
          kind: question ? 'question' : 'ask',
          title: projectNameOf(pid),
          body: question ? 'Needs an answer' : summarizeRequest(still.params).text,
          session: still.params?.sessionId,
          req: { server: pid, id: still.id },
        });
      } catch { /* never throws */ }
    }, pushDelayMs);
    timer.unref?.();
    pendingPushTimers.set(key, timer);
  }

  // Push to every paired phone that registered a push endpoint and has a key. A phone that talked to
  // this relay recently is looking at its screen already — skipped, unless the news is one of the
  // kinds that always go out (ask, question, failed). A gone answer clears the registration; the
  // phone re-registers the next time it is opened. Never throws.
  async function notifyDevices({ kind, title, body, session, project, req } = {}) {
    const summary = { sent: 0, skipped: 0, gone: 0 };
    if (!pusher) return summary;
    try {
      const windowMs = pusher.activeWindowMs ?? 30000;
      const now = Date.now();
      const always = kind === 'ask' || kind === 'question' || kind === 'failed';
      for (const device of readJson(DEVICES, [])) {
        try {
          if (!device.push || !device.pushKey) continue;               // never paired for push: quiet
          const active = [...clients].some((c) => c.authed && c.device?.id === device.id && c.lastSeenAt && now - c.lastSeenAt < windowMs);
          if (active && !always) { summary.skipped += 1; continue; }
          const out = await pusher.send(device, { kind, title, body, session, project, req });
          if (out?.gone) {
            const devs = readJson(DEVICES, []);
            const at = devs.findIndex((d) => d.id === device.id);
            if (at >= 0) { delete devs[at].push; writeJson(DEVICES, devs); }
            summary.gone += 1;
          } else if (out?.ok) summary.sent += 1;
          else summary.skipped += 1;
        } catch { /* one bad device never stops the rest */ }
      }
    } catch { /* never throws */ }
    return summary;
  }

  // ---- server --------------------------------------------------------------------
  function start() {
    if (running) return Promise.resolve({ host: hosts[0], port });
    const failures = new Map();                                     // ip -> {n, until}
    const throttled = ip => (failures.get(ip)?.until ?? 0) > Date.now();
    const fail = ip => { const f = failures.get(ip) ?? { n: 0 }; f.n++; if (f.n >= 5) { f.until = Date.now() + 60_000; f.n = 0; } failures.set(ip, f); };
    const handle = (req, res) => {
      const ip = req.socket.remoteAddress;
      if (req.method === 'GET' && req.url === '/health') { res.end(JSON.stringify({ ok: true, servers: upstream.size })); return; }
      if (req.method === 'POST' && req.url === '/pair') {
        if (throttled(ip)) { res.writeHead(429).end(); return; }
        let b = ''; req.on('data', d => { b += d; if (b.length > 4096) req.destroy(); });
        req.on('end', () => {
          let j = {}; try { j = JSON.parse(b); } catch {}
          const r = redeem(j.code, j.name);
          if (!r) { fail(ip); res.writeHead(403, { 'content-type': 'application/json' }).end('{"error":"invalid or expired code"}'); return; }
          log.log(`paired device ${r.id} (${j.name})`);
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(r));
        });
        return;
      }
      res.writeHead(404).end();
    };
    // One shared WebSocketServer and one shared /pair handler behind every listener: each server hands
    // its upgrades to the same wss, so phones get identical service on every address.
    wss = new WebSocketServer({ noServer: true, maxPayload: 14 * 1024 * 1024 });   // an 8 MiB upload is ~10.7 MiB as base64; MAX_FRAME still caps frames to phones
    wss.on('error', () => {});                    // a client socket error must never become an uncaught throw
    wss.on('connection', (ws, req) => {
      const ip = req.socket.remoteAddress; const c = { ws, authed: false, device: null };
      log.log(`connection from ${ip} to ${req.socket.localAddress}`);        // which way in a phone used (Wi-Fi or Tailscale)
      const authTimer = setTimeout(() => ws.close(4001, 'auth timeout'), 10_000);
      ws.on('close', () => { if (clients.delete(c)) emitStatus(); clearTimeout(authTimer); });
      ws.on('message', raw => {
        c.lastSeenAt = Date.now();                                    // any frame counts as activity (the phone is awake)
        let m; try { m = JSON.parse(String(raw)); } catch { return; }
        if (!c.authed) {
          if (m.type !== 'auth' || throttled(ip)) return ws.close(4003, 'auth required');
          const d = findDevice(m.token);
          if (!d) { fail(ip); return ws.close(4003, 'bad token'); }
          c.authed = true; c.device = d; clients.add(c); clearTimeout(authTimer); emitStatus();
          log.log(`device ${d.id} connected from ${ip}`);
          send(c, { type: 'ready', protocol: PROTOCOL, device: d.id, servers: [...upstream.values()].map(u => ({ pid: u.meta.pid, cwd: u.meta.cwd })), seq, pending: [...pendingReq.values()], features: { stt: !!stt, push: true }, addresses: [...publicUrls] });
          if (typeof m.since === 'number') for (const e of replay) if (e.seq > m.since) send(c, { type: 'event', ...e });
          return;
        }
        if (m.type === 'servers') return send(c, { type: 'servers', servers: [...upstream.values()].map(u => ({ pid: u.meta.pid, cwd: u.meta.cwd })) });
        if (m.type === 'pending') return send(c, { type: 'pending', pending: [...pendingReq.values()] });
        if (m.type === 'respond') {                                   // answer a permission request: {type, rid, server, id, decision, reason?}
          const key = `${m.server}:${m.id}`; const u = upstream.get(m.server); const p = pendingReq.get(key);
          const fail = message => send(c, { type: 'rpc-result', id: m.rid, error: { code: -32011, message } });
          if (!u || !p) return fail('request is not pending (already answered?)');
          if (p.method !== 'interaction/requestPermission') return fail('only permission requests can be answered from mobile');
          if (!DECISIONS.has(m.decision)) return fail('decision must be allow or deny');
          const id = clientRoute(c, m.rid, m.server, 'tap/respond');
          log.log(`respond ${c.device.id} ${m.decision} ${p.params?.toolName ?? '?'} -> ${m.server}`);
          try { u.sock.write(JSON.stringify({ id, method: 'tap/respond', params: { id: m.id, result: { decision: m.decision, ...(typeof m.reason === 'string' ? { reason: m.reason.slice(0, 500) } : {}) } } }) + '\n'); }
          catch { clearTimeout(routes.get(id)?.timer); routes.delete(id); fail('the server just went away'); }   // a dead socket must not throw out of the message handler
          return;
        }
        if (m.type === 'resume') { for (const e of replay) if (e.seq > (m.since ?? 0)) send(c, { type: 'event', ...e }); return; }
        if (m.type === 'rpc') {
          const bad = checkPolicy(m.method, m.params);
          if (bad) return send(c, { type: 'rpc-result', id: m.id, error: { code: -32001, message: bad } });
          if (m.method === 'stt/transcribe' || m.method === 'stt/status') return handleStt(c, m);   // relay-answered: no upstream needed, never forwarded
          if (m.method === 'push/register' || m.method === 'push/unregister') return handlePushRpc(c, m);   // relay-answered too
          const u = (m.server && upstream.get(m.server)) || [...upstream.values()].find(x => x.meta.cwd === m.params?.workspace?.workspacePath) || [...upstream.values()][0];
          if (!u) return send(c, { type: 'rpc-result', id: m.id, error: { code: -32002, message: 'no ZCode server (is Zode.app running?)' } });
          if (m.method === 'attachment/upload') return uploadAttachment(c, m, u);        // multi-step: resume, begin, chunks, commit
          if (m.method === 'session/send' && Array.isArray(m.params?.attachments) && m.params.attachments.length) return sendWithAttachments(c, m, u);
          const id = clientRoute(c, m.id, u.meta.pid, m.method);
          const cmd = COMMANDS[m.method];
          if (cmd) {                                                      // rename goes out as the agent's one command shape
            log.log(`${cmd.verb} ${c.device.id} ${m.params.sessionId}`);
            callUpstream(u, 'session/resume', { sessionId: m.params.sessionId }).catch(() => {}).then(() => {   // the command needs an active session
              try { u.sock.write(JSON.stringify({ id, method: 'v4/command',
                params: { commandId: crypto.randomUUID(), clientId: 'zode-relay', sessionId: m.params.sessionId, type: cmd.type, payload: cmd.payload(m.params), issuedAt: Date.now() } }) + '\n'); } catch {}
            });
            return;
          }
          log.log(`rpc ${c.device.id} ${m.method} -> ${u.meta.pid}`);
          u.sock.write(JSON.stringify({ id, method: m.method, params: m.params }) + '\n');
        }
      });
    });
    servers = hosts.map(host => {
      const srv = http.createServer(handle);
      srv.on('upgrade', (req, sock, head) => { try { wss.handleUpgrade(req, sock, head, ws => wss.emit('connection', ws, req)); } catch { /* the client retries */ } });
      return { host, srv };
    });
    syncTimer = setInterval(syncUpstream, 2000); syncUpstream();
    if (pendingSyncMs > 0) {                                        // the wrapper's truth, checked regularly
      pendingTimer = setInterval(() => { for (const pid of [...upstream.keys()]) requestPending(pid); }, pendingSyncMs);
      pendingTimer.unref?.();
    }
    return new Promise((resolve, reject) => {
      let failed = false, listening = 0;
      const boom = async err => {                     // the first bind error closes every other listener, as a failed start always did
        if (failed) return;
        failed = true;
        await stop().catch(() => {});
        reject(err);
      };
      for (const { host, srv } of servers) {
        srv.once('error', err => boom(err));
        srv.listen(port, host, () => {
          if (failed || ++listening < servers.length) return;         // resolved only when every address answers
          running = true;
          log.log(`zcode-relay listening ${hosts.map(h => `ws://${h}:${port}`).join(' and ')}  (upstream servers: ${upstream.size})`);
          emitStatus();
          resolve({ host: hosts[0], port });
        });
      }
    });
  }

  async function stop() {
    const all = servers, w = wss, t = syncTimer, pt = pendingTimer;
    if (!running && all.length === 0 && !w && !t && !pt) return;    // safe to call twice
    running = false; servers = []; wss = null; syncTimer = null; pendingTimer = null;
    if (t) clearInterval(t);
    if (pt) clearInterval(pt);
    for (const u of upstream.values()) u.sock.destroy();
    upstream.clear();
    for (const r of routes.values()) clearTimeout(r.timer);
    routes.clear(); pendingReq.clear(); live.setPending([]);
    for (const c of [...clients]) { try { c.ws.close(1001, 'relay stopping'); } catch {} }
    clients.clear();
    if (w) { try { await new Promise(r => w.close(r)); } catch {} }
    for (const { srv } of all) {
      try { srv.closeIdleConnections?.(); await new Promise(r => srv.close(() => r())); } catch {}
    }
    emitStatus();
  }

  return { start, stop, status, createPairing, listDevices, revokeDevice, on, off, liveStatus: live, notifyDevices };
}
