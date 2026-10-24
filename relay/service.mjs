// zode-relay service: the phone relay as a startable module. Zode.app embeds this; relay.mjs is a thin CLI over it.
// Upstream : unix sockets from Zode.app (~/.zcode-tap/*.json), one per workspace server.
// Downstream: paired phones over WebSocket. Pair and revoke through createPairing() / revokeDevice().
// Transport security is the network's job: bind to a Tailscale/WireGuard address. Default is 127.0.0.1.
import { withRealActivity } from './activity.mjs';
import { createLiveStatus } from './live.mjs';
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
  'stt/transcribe', 'stt/status']);
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

function checkAttachment(a, sessionId) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return 'each attachment must be an object';
  if (typeof a.ref !== 'string' || !a.ref.startsWith(`zcode-artifact://${sessionId}/`)) return 'attachment ref must be a zcode-artifact:// ref of this session';
  if (typeof a.fileName !== 'string' || !a.fileName.length || a.fileName.length > 200) return 'attachment fileName must be 1-200 characters';
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
  let servers = [], wss = null, syncTimer = null, statusTimer = null;
  let running = false;

  // What is really running, from the event stream the servers already send: session/list keeps
  // saying 'idle' mid-turn, so every upstream line feeds this tracker, every session/list reply to a
  // phone carries its verdict, and the host reads the same truth through relay.liveStatus.
  const live = createLiveStatus();
  const syncPending = () => live.setPending([...pendingReq.values()].map(p => ({ sessionId: p.params?.sessionId, method: p.method })));

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
      sock.on('data', d => { u.buf += d; let i; while ((i = u.buf.indexOf('\n')) >= 0) { const l = u.buf.slice(0, i); u.buf = u.buf.slice(i + 1); if (l.trim()) fromUpstream(pid, l); } });
      sock.on('close', () => {
        upstream.delete(pid); emitStatus();
        for (const k of pendingReq.keys()) if (k.startsWith(pid + ':')) pendingReq.delete(k);
        syncPending();
        for (const [rid, r] of routes) if (r.internalCall && r.pid === pid) { routes.delete(rid); clearTimeout(r.timer); r.reject(new Error('upstream closed')); }
      });
      sock.on('error', () => {});
      const sid = ++relayId; routes.set(sid, { internal: true, pid });       // ask the wrapper what is already pending
      sock.write(JSON.stringify({ id: sid, method: 'tap/pending', params: {} }) + '\n');
    }
  }
  function fromUpstream(pid, line) {
    let m; try { m = JSON.parse(line); } catch { return; }
    live.observe(m);                                                // every line feeds the running tracker; it ignores what is not session traffic
    if (m.id !== undefined && !m.method) {                          // reply
      if (!m.tapReply) return;                                      // copy of a desktop reply
      const r = routes.get(m.id); if (!r) return; routes.delete(m.id);
      if (r.internal) { for (const p of m.result?.pending ?? []) pendingReq.set(`${r.pid}:${p.id}`, { server: r.pid, ...p }); syncPending(); return; }
      if (r.internalCall) {
        clearTimeout(r.timer);
        const err = m.error ?? (m.result?.status === 'rejected' ? m.result : m.result?.error);
        if (err) return r.reject(new Error(err.message ?? err.reasonCode ?? (typeof err === 'string' ? err : 'upstream error')));
        return r.resolve(m.result);
      }
      delete m.tapReply; m.id = r.clientId;
      // The agent reports updatedAt = now for every conversation it has loaded; ZCode's database has the real time.
      if (r.method === 'session/list' && Array.isArray(m.result?.sessions)) {
        m.result.sessions = withRealActivity(m.result.sessions);
        m.result.sessions = live.apply(m.result.sessions);          // the live verdict wins, after the real times
      }
      return send(r.client, { type: 'rpc-result', server: pid, ...fitForMobile(r.method, m) });
    }
    if (m.method === 'startup/storageState' || m.method === 'process/mcpTelemetry' || m.method?.startsWith('v4/telemetry')) return;
    if (m.method && m.id !== undefined && /^interaction\/request(Permission|UserInput)$/.test(m.method)) {
      pendingReq.set(`${pid}:${m.id}`, { server: pid, id: m.id, method: m.method, params: m.params, at: Date.now() });
      syncPending();
    }
    if (m.method === 'tap/resolved') { pendingReq.delete(`${pid}:${m.params?.id}`); syncPending(); }
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
      const timer = setTimeout(() => { if (routes.delete(id)) reject(new Error(`${method} timed out`)); }, 30_000);
      timer.unref?.();
      routes.set(id, { internalCall: true, pid: u.meta.pid, resolve, reject, timer });
      try { u.sock.write(JSON.stringify({ id, method, params }) + '\n'); }
      catch (err) { clearTimeout(timer); routes.delete(id); reject(err); }
    });
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
    const devs = readJson(DEVICES, []); devs.push({ id, name: String(name || 'phone').slice(0, 60), tokenHash: sha(token), pairedAt: Date.now() });
    writeJson(DEVICES, devs); emitStatus();
    return { id, token };
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
  function listDevices() { return readJson(DEVICES, []).map(({ id, name, pairedAt }) => ({ id, name, pairedAt })); }
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
      const fileName = p.fileName.replace(/[\/\\\x00-\x1f\x7f]/g, '_');     // the agent stages files under this name
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
      const payload = { text: p.content, attachments: p.attachments.map(ATTACH_FIELDS) };
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
      const authTimer = setTimeout(() => ws.close(4001, 'auth timeout'), 10_000);
      ws.on('close', () => { if (clients.delete(c)) emitStatus(); clearTimeout(authTimer); });
      ws.on('message', raw => {
        let m; try { m = JSON.parse(String(raw)); } catch { return; }
        if (!c.authed) {
          if (m.type !== 'auth' || throttled(ip)) return ws.close(4003, 'auth required');
          const d = findDevice(m.token);
          if (!d) { fail(ip); return ws.close(4003, 'bad token'); }
          c.authed = true; c.device = d; clients.add(c); clearTimeout(authTimer); emitStatus();
          send(c, { type: 'ready', protocol: PROTOCOL, device: d.id, servers: [...upstream.values()].map(u => ({ pid: u.meta.pid, cwd: u.meta.cwd })), seq, pending: [...pendingReq.values()], features: { stt: !!stt }, addresses: [...publicUrls] });
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
          const id = ++relayId; routes.set(id, { client: c, clientId: m.rid, pid: m.server });
          log.log(`respond ${c.device.id} ${m.decision} ${p.params?.toolName ?? '?'} -> ${m.server}`);
          u.sock.write(JSON.stringify({ id, method: 'tap/respond', params: { id: m.id, result: { decision: m.decision, ...(typeof m.reason === 'string' ? { reason: m.reason.slice(0, 500) } : {}) } } }) + '\n');
          return;
        }
        if (m.type === 'resume') { for (const e of replay) if (e.seq > (m.since ?? 0)) send(c, { type: 'event', ...e }); return; }
        if (m.type === 'rpc') {
          const bad = checkPolicy(m.method, m.params);
          if (bad) return send(c, { type: 'rpc-result', id: m.id, error: { code: -32001, message: bad } });
          if (m.method === 'stt/transcribe' || m.method === 'stt/status') return handleStt(c, m);   // relay-answered: no upstream needed, never forwarded
          const u = (m.server && upstream.get(m.server)) || [...upstream.values()].find(x => x.meta.cwd === m.params?.workspace?.workspacePath) || [...upstream.values()][0];
          if (!u) return send(c, { type: 'rpc-result', id: m.id, error: { code: -32002, message: 'no ZCode server (is Zode.app running?)' } });
          if (m.method === 'attachment/upload') return uploadAttachment(c, m, u);        // multi-step: resume, begin, chunks, commit
          if (m.method === 'session/send' && Array.isArray(m.params?.attachments) && m.params.attachments.length) return sendWithAttachments(c, m, u);
          const id = ++relayId; routes.set(id, { client: c, clientId: m.id, pid: u.meta.pid, method: m.method });
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
    const all = servers, w = wss, t = syncTimer;
    if (!running && all.length === 0 && !w && !t) return;           // safe to call twice
    running = false; servers = []; wss = null; syncTimer = null;
    if (t) clearInterval(t);
    for (const u of upstream.values()) u.sock.destroy();
    upstream.clear();
    routes.clear(); pendingReq.clear(); live.setPending([]);
    for (const c of [...clients]) { try { c.ws.close(1001, 'relay stopping'); } catch {} }
    clients.clear();
    if (w) { try { await new Promise(r => w.close(r)); } catch {} }
    for (const { srv } of all) {
      try { srv.closeIdleConnections?.(); await new Promise(r => srv.close(() => r())); } catch {}
    }
    emitStatus();
  }

  return { start, stop, status, createPairing, listDevices, revokeDevice, on, off, liveStatus: live };
}
