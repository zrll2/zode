#!/usr/bin/env node
// zcode-relay: WebSocket gateway on this Mac for the ZCode mobile client.
// Upstream : unix sockets from ZCode-Tap (~/.zcode-tap/*.json), one per workspace server.
// Downstream: paired phones over WebSocket. Pair with `relay.mjs pair`; list/revoke with `devices` / `revoke <id>`.
// Transport security is the network's job: bind to a Tailscale/WireGuard address (RELAY_HOST). Default is 127.0.0.1.
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import qr from 'qrcode-terminal';

const HOME = os.homedir();
const TAP_DIR = path.join(HOME, '.zcode-tap');
const STATE_DIR = process.env.RELAY_STATE_DIR || path.join(HOME, '.zode', 'relay');
const DEVICES = path.join(STATE_DIR, 'devices.json');
const CODES = path.join(STATE_DIR, 'pair-codes.json');
const PORT = Number(process.env.RELAY_PORT || 8787);
const HOST = process.env.RELAY_HOST || '127.0.0.1';
const PUBLIC_URL = process.env.RELAY_PUBLIC_URL || `ws://${HOST}:${PORT}`;
const CODE_TTL_MS = 5 * 60 * 1000;
const REPLAY_MAX = 5000;

fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { fs.writeFileSync(f, JSON.stringify(v, null, 1), { mode: 0o600 }); fs.chmodSync(f, 0o600); };
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const eq = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };

// ---- policy: what a phone may call ------------------------------------------
const ALLOWED = new Set(['session/list', 'session/create', 'session/resume', 'session/read', 'session/messages', 'session/events',
  'session/subscribe', 'session/send', 'session/stop', 'session/close', 'session/setModel', 'session/setThoughtLevel', 'session/setMode',
  'session/usage', 'session/goal', 'session/compact']);
const SAFE_MODES = new Set(['plan', 'edit', 'guarded']);       // never yolo / build from a phone
export function checkPolicy(method, params) {
  if (!ALLOWED.has(method)) return `method not allowed: ${method}`;
  const mode = method === 'session/create' ? params?.mode : method === 'session/setMode' ? (params?.mode ?? params?.current) : undefined;
  if (method === 'session/create' && mode === undefined) return 'mode required (plan|edit|guarded)';
  if (mode !== undefined && !SAFE_MODES.has(mode)) return `mode not allowed from mobile: ${mode}`;
  return null;
}

// ---- upstream (tap) ---------------------------------------------------------
const upstream = new Map();         // pid -> {meta, sock, buf}
const routes = new Map();           // relay request id -> {client, clientId, pid}
let relayId = 0, seq = 0;
const replay = [];                  // [{seq, server, msg}]
const clients = new Set();
const pendingReq = new Map();      // `${pid}:${id}` -> {server, id, method, params, at}  (permission / user-input requests waiting for an answer)
const DECISIONS = new Set(['allow', 'deny']);   // a phone may only allow or deny; never modify, escalate or add rules

function livePids() {
  let metas = [];
  try { metas = fs.readdirSync(TAP_DIR).filter(f => f.endsWith('.json')).map(f => readJson(path.join(TAP_DIR, f))); } catch {}
  return metas.filter(m => { try { process.kill(m.pid, 0); return true; } catch { return false; } });
}
function syncUpstream() {
  const live = new Map(livePids().map(m => [m.pid, m]));
  for (const [pid, u] of upstream) if (!live.has(pid)) { u.sock.destroy(); upstream.delete(pid); }
  for (const [pid, meta] of live) {
    if (upstream.has(pid)) continue;
    const sock = net.connect(meta.sock); const u = { meta, sock, buf: '' }; upstream.set(pid, u);
    sock.on('data', d => { u.buf += d; let i; while ((i = u.buf.indexOf('\n')) >= 0) { const l = u.buf.slice(0, i); u.buf = u.buf.slice(i + 1); if (l.trim()) fromUpstream(pid, l); } });
    sock.on('close', () => { upstream.delete(pid); for (const k of pendingReq.keys()) if (k.startsWith(pid + ':')) pendingReq.delete(k); }); sock.on('error', () => {});
    const sid = ++relayId; routes.set(sid, { internal: true, pid });       // ask the wrapper what is already pending
    sock.write(JSON.stringify({ id: sid, method: 'tap/pending', params: {} }) + '\n');
  }
}
function fromUpstream(pid, line) {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id !== undefined && !m.method) {                          // reply
    if (!m.tapReply) return;                                      // copy of a desktop reply
    const r = routes.get(m.id); if (!r) return; routes.delete(m.id);
    if (r.internal) { for (const p of m.result?.pending ?? []) pendingReq.set(`${r.pid}:${p.id}`, { server: r.pid, ...p }); return; }
    delete m.tapReply; m.id = r.clientId;
    return send(r.client, { type: 'rpc-result', server: pid, ...fitForMobile(r.method, m) });
  }
  if (m.method === 'startup/storageState' || m.method === 'process/mcpTelemetry' || m.method?.startsWith('v4/telemetry')) return;
  if (m.method && m.id !== undefined && /^interaction\/request(Permission|UserInput)$/.test(m.method)) pendingReq.set(`${pid}:${m.id}`, { server: pid, id: m.id, method: m.method, params: m.params, at: Date.now() });
  if (m.method === 'tap/resolved') pendingReq.delete(`${pid}:${m.params?.id}`);
  const e = { seq: ++seq, server: pid, msg: m };
  replay.push(e); if (replay.length > REPLAY_MAX) replay.shift();
  for (const c of clients) if (c.authed) send(c, JSON.stringify(e).length > MAX_FRAME ? { type: 'event', seq: e.seq, server: pid, msg: { method: m.method, params: { sessionId: m.params?.sessionId, type: m.params?.type, truncated: true } } } : { type: 'event', ...e });
}
// iOS closes a WebSocket on a frame above 1 MiB (URLSessionWebSocketTask default). Keep every frame well below that.
const MAX_FRAME = 800_000;
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
const startUpstream = () => { setInterval(syncUpstream, 2000); syncUpstream(); };

// ---- pairing / devices -------------------------------------------------------
function newPairCode() {
  const code = crypto.randomBytes(4).toString('hex').toUpperCase();
  const all = readJson(CODES, {}); for (const k of Object.keys(all)) if (all[k] < Date.now()) delete all[k];
  all[sha(code)] = Date.now() + CODE_TTL_MS; writeJson(CODES, all);
  return code;
}
function redeem(code, name) {
  const all = readJson(CODES, {}); const k = sha(String(code || '').toUpperCase());
  const exp = all[k]; if (!exp || exp < Date.now()) return null;
  delete all[k]; writeJson(CODES, all);                           // one-time
  const token = crypto.randomBytes(32).toString('base64url'); const id = crypto.randomBytes(4).toString('hex');
  const devs = readJson(DEVICES, []); devs.push({ id, name: String(name || 'phone').slice(0, 60), tokenHash: sha(token), pairedAt: Date.now() });
  writeJson(DEVICES, devs); return { id, token };
}
const findDevice = token => readJson(DEVICES, []).find(d => eq(d.tokenHash, sha(String(token))));

// ---- server --------------------------------------------------------------------
function serve() {
  startUpstream();
  const failures = new Map();                                     // ip -> {n, until}
  const throttled = ip => (failures.get(ip)?.until ?? 0) > Date.now();
  const fail = ip => { const f = failures.get(ip) ?? { n: 0 }; f.n++; if (f.n >= 5) { f.until = Date.now() + 60_000; f.n = 0; } failures.set(ip, f); };
  const srv = http.createServer((req, res) => {
    const ip = req.socket.remoteAddress;
    if (req.method === 'GET' && req.url === '/health') { res.end(JSON.stringify({ ok: true, servers: upstream.size })); return; }
    if (req.method === 'POST' && req.url === '/pair') {
      if (throttled(ip)) { res.writeHead(429).end(); return; }
      let b = ''; req.on('data', d => { b += d; if (b.length > 4096) req.destroy(); });
      req.on('end', () => {
        let j = {}; try { j = JSON.parse(b); } catch {}
        const r = redeem(j.code, j.name);
        if (!r) { fail(ip); res.writeHead(403, { 'content-type': 'application/json' }).end('{"error":"invalid or expired code"}'); return; }
        console.log(`paired device ${r.id} (${j.name})`);
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(r));
      });
      return;
    }
    res.writeHead(404).end();
  });
  const wss = new WebSocketServer({ server: srv, maxPayload: 2 * 1024 * 1024 });
  wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress; const c = { ws, authed: false, device: null };
    const authTimer = setTimeout(() => ws.close(4001, 'auth timeout'), 10_000);
    ws.on('close', () => { clients.delete(c); clearTimeout(authTimer); });
    ws.on('message', raw => {
      let m; try { m = JSON.parse(String(raw)); } catch { return; }
      if (!c.authed) {
        if (m.type !== 'auth' || throttled(ip)) return ws.close(4003, 'auth required');
        const d = findDevice(m.token);
        if (!d) { fail(ip); return ws.close(4003, 'bad token'); }
        c.authed = true; c.device = d; clients.add(c); clearTimeout(authTimer);
        send(c, { type: 'ready', device: d.id, servers: [...upstream.values()].map(u => ({ pid: u.meta.pid, cwd: u.meta.cwd })), seq, pending: [...pendingReq.values()] });
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
        console.log(`respond ${c.device.id} ${m.decision} ${p.params?.toolName ?? '?'} -> ${m.server}`);
        u.sock.write(JSON.stringify({ id, method: 'tap/respond', params: { id: m.id, result: { decision: m.decision, ...(typeof m.reason === 'string' ? { reason: m.reason.slice(0, 500) } : {}) } } }) + '\n');
        return;
      }
      if (m.type === 'resume') { for (const e of replay) if (e.seq > (m.since ?? 0)) send(c, { type: 'event', ...e }); return; }
      if (m.type === 'rpc') {
        const bad = checkPolicy(m.method, m.params);
        if (bad) return send(c, { type: 'rpc-result', id: m.id, error: { code: -32001, message: bad } });
        const u = (m.server && upstream.get(m.server)) || [...upstream.values()].find(x => x.meta.cwd === m.params?.workspace?.workspacePath) || [...upstream.values()][0];
        if (!u) return send(c, { type: 'rpc-result', id: m.id, error: { code: -32002, message: 'no ZCode server (is ZCode-Tap running?)' } });
        const id = ++relayId; routes.set(id, { client: c, clientId: m.id, pid: u.meta.pid, method: m.method });
        console.log(`rpc ${c.device.id} ${m.method} -> ${u.meta.pid}`);
        u.sock.write(JSON.stringify({ id, method: m.method, params: m.params }) + '\n');
      }
    });
  });
  srv.listen(PORT, HOST, () => console.log(`zcode-relay listening ws://${HOST}:${PORT}  (upstream servers: ${upstream.size})`));
  if (HOST === '0.0.0.0') console.warn('WARNING: bound to all interfaces without TLS. Prefer a Tailscale/WireGuard address.');
}

// ---- CLI -----------------------------------------------------------------------
const cmd = process.argv[2] ?? 'serve';
if (process.argv[1] === new URL(import.meta.url).pathname) {
  if (cmd === 'serve') serve();
  else if (cmd === 'pair') {
    const code = newPairCode();
    const payload = JSON.stringify({ u: PUBLIC_URL.replace(/^ws/, 'http'), w: PUBLIC_URL, c: code });
    console.log(`Pair code ${code} (valid 5 minutes, one use). Relay: ${PUBLIC_URL}`);
    qr.generate(payload, { small: true }); console.log(payload);
  } else if (cmd === 'devices') for (const d of readJson(DEVICES, [])) console.log(d.id, d.name, new Date(d.pairedAt).toISOString());
  else if (cmd === 'revoke') { const devs = readJson(DEVICES, []).filter(d => d.id !== process.argv[3]); writeJson(DEVICES, devs); console.log('revoked', process.argv[3]); }
  else console.log('usage: relay.mjs [serve|pair|devices|revoke <id>]');
  if (cmd !== 'serve') process.exit(0);
}
