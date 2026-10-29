// The relay as an embeddable service: lifecycle, pairing, devices, per-instance isolation, upstream events, rpc policy and forwarding.
// Port 0 is not supported (the pairing payload embeds the port), so each test asks the OS for a free port first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import WebSocket from 'ws';
import { createRelay, checkPolicy, PROTOCOL } from '../service.mjs';
import { createAuditLog } from '../audit.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const silent = { log() {}, warn() {}, error() {} };
const tmp = () => fs.mkdtempSync(path.join('/tmp', 'relay-test-'));
const rm = (...dirs) => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); };

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer(); s.unref();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  s.on('error', reject);
});
const pair = (port, code, name) => fetch(`http://127.0.0.1:${port}/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, name }) });

function authed(url, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on('error', reject);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token })));
    ws.on('message', function onMsg(d) { const m = JSON.parse(String(d)); if (m.type === 'ready') { ws.off('message', onMsg); resolve({ ws, ready: m }); } });
  });
}
const nextMessage = (ws, match, ms = 3000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => { ws.off('message', onMsg); reject(new Error('timed out waiting for message')); }, ms);
  const onMsg = (d) => { const m = JSON.parse(String(d)); if (!match || match(m)) { clearTimeout(t); ws.off('message', onMsg); resolve(m); } };
  ws.on('message', onMsg);
});
const waitFor = async (fn, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return; await sleep(25); } throw new Error('condition not met in time'); };

// A fake agent upstream: a unix socket plus the <pid>.json meta file syncUpstream scans for. It records every request
// the relay forwards, answers tap/pending itself, and auto-answers the relay's internal calls (session/resume, the
// attachment staging); tests override an answer with answer() or reply to a recorded request manually with respond().
function fakeUpstream() {
  const home = tmp();
  const tapDir = path.join(home, 'tap'); fs.mkdirSync(tapDir);
  const sockPath = path.join(tapDir, 'upstream.sock');
  const received = [];
  let sock = null, beginSession = null, commitSeq = 0, pendingAsks = 0;
  const answers = {
    'session/resume': () => ({}),
    'v4/attachment/begin': (m) => { beginSession = m.params.sessionId; return { uploadId: m.params.uploadId, state: 'staging', nextChunkIndex: 0 }; },
    'v4/attachment/chunk': (m) => ({ uploadId: m.params.uploadId, nextChunkIndex: m.params.chunkIndex + 1 }),
    'v4/attachment/commit': () => ({ ref: `zcode-artifact://${beginSession}/tool-result-${commitSeq++}` }),
  };
  let readyResolve = null;
  const ready = new Promise((resolve) => { readyResolve = resolve; });   // resolves when a connection is accepted
  const server = net.createServer((s) => {
    readyResolve();
    sock = s; let buf = '';
    s.on('data', (d) => {
      buf += d; let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const l = buf.slice(0, i); buf = buf.slice(i + 1); if (!l.trim()) continue;
        const m = JSON.parse(l);
        if (m.method === 'tap/pending') {
          pendingAsks += 1;
          const answer = answers['tap/pending'];
          s.write(JSON.stringify({ id: m.id, tapReply: true, result: answer ? answer(m) : { pending: [] } }) + '\n');
        }
        else {
          received.push(m);
          const answer = answers[m.method];
          if (answer) s.write(JSON.stringify({ id: m.id, tapReply: true, result: answer(m) }) + '\n');
        }
      }
    });
  });
  server.listen(sockPath);
  fs.writeFileSync(path.join(tapDir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, cwd: '/tmp/fake-workspace', sock: sockPath }));
  return {
    home, tapDir, received,
    get pendingAsks() { return pendingAsks; },                      // how often the relay asked what is still pending
    answer: (method, fn) => { answers[method] = fn; },
    send: (o) => { const line = JSON.stringify(o) + '\n'; if (sock) sock.write(line); else ready.then(() => sock.write(line)); },   // upstream -> relay (queued until the relay has connected)
    sendAndDie: async (o) => {                                                                      // a request whose socket dies mid-flight
      try {
        await ready;                                                                                  // never before a connection exists
        if (!sock) return;
        sock.write(JSON.stringify(o) + '\n');
        sock.destroy();
      } catch { /* the socket is gone: that is the point */ }
    },
    respond: (m, result) => sock.write(JSON.stringify({ id: m.id, tapReply: true, result }) + '\n'),
    close: async () => { sock?.destroy(); await new Promise((r) => server.close(r)); rm(home); },
  };
}

// A fake host speech engine (the `stt` option): records every request; tests override what it
// answers through `over` (and can mutate `over` between calls).
function fakeStt(over = {}) {
  const calls = [];
  return {
    calls,
    transcribe: async (req) => {
      calls.push({ kind: 'transcribe', req });
      if (over.transcribe) return over.transcribe(req);
      return { ok: true, text: 'hello worktree', ms: 42, language: req.language ?? 'en' };
    },
    status: async () => {
      calls.push({ kind: 'status' });
      return over.status ?? { engine: true, models: { small: { state: 'ready', bytes: 487601967 }, 'base.en': { state: 'missing', bytes: 0 } } };
    },
    defaultLanguage: () => over.language ?? 'en',
  };
}

test('start / status / stop; stop twice is safe; busy port rejects with EADDRINUSE', async () => {
  const state = tmp(), tap = tmp(), busyState = tmp();
  try {
    const port = await freePort();
    const relay = createRelay({ port, stateDir: state, tapDir: tap, log: silent });
    assert.equal(relay.status().running, false);

    assert.deepEqual(await relay.start(), { host: '127.0.0.1', port });
    const st = relay.status();
    assert.equal(st.running, true);
    assert.equal(st.host, '127.0.0.1');
    assert.equal(st.port, port);
    assert.equal(st.publicUrl, `ws://127.0.0.1:${port}`);
    assert.equal(st.upstreams, 0);
    assert.equal(st.clients, 0);
    assert.equal(st.devices, 0);

    await relay.stop();
    await relay.stop();                                                   // second stop must not throw
    assert.equal(relay.status().running, false);

    const busyPort = await freePort();
    const holder = net.createServer();
    await new Promise((r) => holder.listen(busyPort, '127.0.0.1', r));
    const busy = createRelay({ port: busyPort, stateDir: busyState, tapDir: tap, log: silent });
    await assert.rejects(busy.start(), (e) => e.code === 'EADDRINUSE');
    assert.equal(busy.status().running, false);
    await new Promise((r) => holder.close(r));
  } finally { rm(state, tap, busyState); }
});

// Two listeners on one port: a LAN IPv4 plus IPv6 loopback (loopback IPv4 is dropped when there is
// more than one host, and a laptop rarely has two LAN addresses). Skips with no LAN address.
const lanHost = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
const multi = lanHost ? test : test.skip;

multi('two hosts: both listeners answer, the payload carries every url, ready lists them, stop closes all', async () => {
  const state = tmp(), tap = tmp();
  try {
    const port = await freePort();
    const urls = [`ws://${lanHost}:${port}`, `ws://[::1]:${port}`];
    const relay = createRelay({ hosts: [lanHost, '::1'], publicUrls: urls, port, stateDir: state, tapDir: tap, log: silent });
    assert.deepEqual(await relay.start(), { host: lanHost, port });
    const st = relay.status();
    assert.deepEqual(st.hosts, [lanHost, '::1']);
    assert.deepEqual(st.publicUrls, urls);

    const p = relay.createPairing();
    const payload = JSON.parse(p.payload);
    assert.equal(payload.u, urls[0].replace('ws:', 'http:'));
    assert.deepEqual(payload.urls, urls);
    assert.equal(payload.c, p.code);
    assert.deepEqual(p.publicUrls, urls);

    const { token } = await (await fetch(`http://${lanHost}:${port}/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: p.code, name: 'phone' }) })).json();
    const { ws, ready } = await authed(urls[1], token);                     // a live socket on the second listener
    assert.deepEqual(ready.addresses, urls);
    const p2 = relay.createPairing();
    const second = await fetch(`http://[::1]:${port}/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: p2.code, name: 'second' }) });
    assert.equal(second.status, 200);                                       // /pair answers on the second listener too
    ws.close();

    await relay.stop();
    for (const base of [`http://${lanHost}:${port}`, `http://[::1]:${port}`]) {
      await assert.rejects(fetch(`${base}/health`));                        // both listeners are gone
    }
  } finally { rm(state, tap); }
});

multi('a bind failure on the second host closes the first listener and rejects', async () => {
  const state = tmp(), tap = tmp();
  try {
    const port = await freePort();
    const holder = net.createServer();                                      // occupies [::1]:<port>
    await new Promise((r, j) => { holder.once('error', j); holder.listen(port, '::1', r); });
    holder.unref();
    const relay = createRelay({ hosts: [lanHost, '::1'], port, stateDir: state, tapDir: tap, log: silent });
    await assert.rejects(relay.start(), (e) => e.code === 'EADDRINUSE');
    assert.equal(relay.status().running, false);
    // the first listener was closed with the second's failure: the LAN address is free again
    await new Promise((r, j) => { const s = net.createServer(); s.once('error', j); s.listen(port, lanHost, () => s.close(r)); });
    await relay.stop();                                                     // safe after a failed start
    await new Promise((r) => holder.close(r));
  } finally { rm(state, tap); }
});

test('pairing: POST /pair returns a token; a code is one-time and expires', async () => {
  const state = tmp(), tap = tmp();
  try {
    const port = await freePort();
    const relay = createRelay({ port, stateDir: state, tapDir: tap, codeTtlMs: 200, log: silent });
    await relay.start();

    const p = relay.createPairing();
    assert.equal(p.payload, JSON.stringify({ u: `http://127.0.0.1:${port}`, urls: [`ws://127.0.0.1:${port}`], w: `ws://127.0.0.1:${port}`, c: p.code }));
    assert.ok(p.expiresAt > Date.now() && p.expiresAt - Date.now() <= 200);

    const res = await pair(port, p.code, 'iphone');
    assert.equal(res.status, 200);
    const r = await res.json();
    assert.ok(r.id && r.token);

    const again = await pair(port, p.code, 'again');                      // one-time: already used
    assert.equal(again.status, 403);

    const p2 = relay.createPairing();
    await sleep(300);                                                     // codeTtlMs is 200
    const expired = await pair(port, p2.code, 'late');
    assert.equal(expired.status, 403);
    await relay.stop();
  } finally { rm(state, tap); }
});

test('listDevices after pairing; revokeDevice removes it and closes the live socket', async () => {
  const state = tmp(), tap = tmp();
  try {
    const port = await freePort();
    const relay = createRelay({ port, stateDir: state, tapDir: tap, log: silent });
    await relay.start();

    const p = relay.createPairing();
    const { id, token } = await (await pair(port, p.code, 'test-phone')).json();
    const devs = relay.listDevices();
    assert.deepEqual(devs, [{ id, name: 'test-phone', pairedAt: devs[0].pairedAt, connected: false }]);
    assert.deepEqual(Object.keys(devs[0]).sort(), ['connected', 'id', 'name', 'pairedAt']);   // no token hash leaks

    const { ws, ready } = await authed(`ws://127.0.0.1:${port}`, token);
    assert.equal(ready.device, id);
    assert.equal(ready.protocol, PROTOCOL);                                  // the phone uses this to know which features this Mac supports
    assert.equal(PROTOCOL, 2);
    assert.equal(relay.status().clients, 1);
    assert.equal(relay.listDevices()[0].connected, true);                    // the authed socket says so
    const closed = new Promise((r) => ws.on('close', (code) => r(code)));

    assert.equal(relay.revokeDevice(id), true);
    assert.deepEqual(relay.listDevices(), []);
    assert.equal(await closed, 4004);
    await waitFor(() => relay.status().clients === 0);
    assert.equal(relay.revokeDevice(id), false);                          // already gone
    await relay.stop();
  } finally { rm(state, tap); }
});

test('two relays in one process do not share devices or codes', async () => {
  const stateA = tmp(), stateB = tmp(), tapA = tmp(), tapB = tmp();
  try {
    const portA = await freePort(), portB = await freePort();
    const a = createRelay({ port: portA, stateDir: stateA, tapDir: tapA, log: silent });
    const b = createRelay({ port: portB, stateDir: stateB, tapDir: tapB, log: silent });
    await a.start(); await b.start();

    const code = a.createPairing().code;
    assert.equal((await pair(portA, code, 'phone-a')).status, 200);
    assert.equal((await pair(portB, code, 'phone-b')).status, 403);       // b does not know a's code
    assert.equal(a.listDevices().length, 1);
    assert.deepEqual(b.listDevices(), []);
    assert.notEqual(a.createPairing().code, b.createPairing().code);
    await a.stop(); await b.stop();
  } finally { rm(stateA, stateB, tapA, tapB); }
});

test("'status' event fires after a device is paired, and off() unsubscribes", async () => {
  const state = tmp(), tap = tmp();
  try {
    const port = await freePort();
    const relay = createRelay({ port, stateDir: state, tapDir: tap, log: silent });
    await relay.start();

    let fired = 0;
    const fn = () => fired++;
    relay.on('status', fn);
    const res = await pair(port, relay.createPairing().code, 'phone');
    assert.equal(res.status, 200);
    await waitFor(() => fired > 0);                                       // debounced, fires within ~250 ms

    relay.off('status', fn);
    const before = fired;
    relay.createPairing();                                                // creates a code, not a device: no event
    await sleep(400);
    assert.equal(fired, before);
    await relay.stop();
  } finally { rm(state, tap); }
});

test('a fake upstream (unix socket + <pid>.json meta) delivers events to an authed phone', async () => {
  const up = fakeUpstream();
  const port = await freePort();
  const relay = createRelay({ port, stateDir: path.join(up.home, 'state'), tapDir: up.tapDir, log: silent });
  await relay.start();
  try {
    await waitFor(() => relay.status().upstreams === 1);
    const { token } = await (await pair(port, relay.createPairing().code, 'phone')).json();
    const { ws, ready } = await authed(`ws://127.0.0.1:${port}`, token);
    assert.deepEqual(ready.servers, [{ pid: process.pid, cwd: '/tmp/fake-workspace' }]);

    up.send({ method: 'session/event', params: { sessionId: 's1', payload: { text: 'hello' } } });
    const evt = await nextMessage(ws, (m) => m.type === 'event');
    assert.equal(evt.server, process.pid);
    assert.equal(evt.msg.method, 'session/event');
    assert.deepEqual(evt.msg.params.payload, { text: 'hello' });
    ws.close();
  } finally {
    await relay.stop();
    await up.close();
  }
});

test('session/list replies carry the live truth: running after prompt_started, idle after prompt_completed, waiting while a request pends', async () => {
  const port = await freePort();
  const up = fakeUpstream();
  const relay = createRelay({ port, stateDir: path.join(up.home, 'state'), tapDir: up.tapDir, log: silent });
  await relay.start();
  try {
    await waitFor(() => relay.status().upstreams === 1);
    const { token } = await (await pair(port, relay.createPairing().code, 'phone')).json();
    const { ws } = await authed(`ws://127.0.0.1:${port}`, token);
    // An id the sqlite activity lookup skips (over 80 characters), so the test never touches a real database.
    const sid = 'sess_' + 'live'.repeat(30);
    const row = () => ({ sessionId: sid, status: 'idle', updatedAt: 123 });
    let answered = 0;
    const askList = async (id) => {
      const resP = nextMessage(ws, (m) => m.type === 'rpc-result' && m.id === id);        // listen first
      ws.send(JSON.stringify({ type: 'rpc', id, method: 'session/list', params: {} }));
      await waitFor(() => up.received.filter(m => m.method === 'session/list').length === answered + 1);
      const req = up.received.filter(m => m.method === 'session/list')[answered];
      answered += 1;
      up.respond(req, { sessions: [row()] });
      return (await resP).result.sessions[0];
    };

    assert.equal((await askList(121)).status, 'idle');                    // the list's own word, before anything happens

    up.send({ method: 'state.updated', params: { type: 'state.updated', scope: 'session', sessionId: sid, patch: { status: 'running' }, reason: 'prompt_started', revision: 1 } });
    const running = await askList(122);
    assert.equal(running.status, 'running');                              // mid-turn, the list would still say idle
    assert.ok(running.updatedAt > 123);                                   // the tracker bumped it to the event time

    up.send({ method: 'state.updated', params: { type: 'state.updated', scope: 'session', sessionId: sid, patch: {}, reason: 'prompt_completed', revision: 2 } });
    const done = await askList(123);
    assert.equal(done.status, 'idle');
    assert.equal(done.updatedAt, 123);                                    // settled: the list's own object stands

    up.send({ id: 'req-9', method: 'interaction/requestPermission', params: { sessionId: sid, toolName: 'Bash', input: {} } });
    assert.equal((await askList(124)).status, 'waiting');                 // an open request outranks the settled status
    up.send({ method: 'tap/resolved', params: { id: 'req-9' } });
    assert.equal((await askList(125)).status, 'idle');
    ws.close();
  } finally { await relay.stop(); await up.close(); }
});

test('the relay reconciles its pending list with what the wrapper still holds', async () => {
  const port = await freePort();
  const up = fakeUpstream();
  const relay = createRelay({ port, stateDir: path.join(up.home, 'state'), tapDir: up.tapDir, log: silent, pendingSyncMs: 60 });
  await relay.start();
  try {
    await waitFor(() => relay.status().upstreams === 1);
    const { token } = await (await pair(port, relay.createPairing().code, 'phone')).json();
    const { ws } = await authed(`ws://127.0.0.1:${port}`, token);
    const until = async (fn, ms = 2000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(25); } throw new Error('condition not met in time'); };
    const askPending = async () => {
      const resP = nextMessage(ws, (m) => m.type === 'pending');
      ws.send(JSON.stringify({ type: 'pending' }));
      return (await resP).pending;
    };
    const sid = 'sess_' + 'r'.repeat(85);                               // over 80 characters: the sqlite activity lookup skips it

    // The wrapper holds one old request: a reconcile brings it to the relay and the phone sees it.
    up.answer('tap/pending', () => ({ pending: [{ id: 'req-1', method: 'interaction/requestPermission', params: { sessionId: sid, toolName: 'Bash' }, at: Date.now() - 10_000 }] }));
    await until(async () => (await askPending()).length === 1);

    // The session's list said waiting while the request stood, and stops once the wrapper's list is empty.
    let lists = 0;
    const askList = async (id) => {
      const resP = nextMessage(ws, (m) => m.type === 'rpc-result' && m.id === id);
      ws.send(JSON.stringify({ type: 'rpc', id, method: 'session/list', params: {} }));
      await waitFor(() => up.received.filter(m => m.method === 'session/list').length === lists + 1);
      const req = up.received.filter(m => m.method === 'session/list')[lists];
      lists += 1;
      up.respond(req, { sessions: [{ sessionId: sid, status: 'idle', updatedAt: 123 }] });
      return (await resP).result.sessions[0];
    };
    assert.equal((await askList(131)).status, 'waiting');
    up.answer('tap/pending', () => ({ pending: [] }));                  // the turn was stopped; the truth is empty
    await until(async () => (await askPending()).length === 0);         // the ghost is gone within a couple of intervals
    assert.equal((await askList(132)).status, 'idle');                  // and the list no longer says waiting

    // A request that just arrived as an event survives a reconcile that does not list it.
    up.send({ id: 'req-2', method: 'interaction/requestPermission', params: { sessionId: sid, toolName: 'Edit' } });
    await until(async () => (await askPending()).some(p => p.id === 'req-2'));
    await sleep(200);                                                   // more than three reconcile intervals
    assert.deepEqual((await askPending()).map(p => p.id), ['req-2']);   // younger than 5 s: kept

    // stop() leaves no timer behind: no further tap/pending goes out.
    const asks = up.pendingAsks;
    await relay.stop();
    await sleep(250);                                                   // more than three reconcile intervals
    assert.equal(up.pendingAsks, asks);
    ws.close();
  } finally { await up.close(); }
});

test('autoAllow answers permission requests at once — once — and never touches questions', async () => {
  const port = await freePort();
  const up = fakeUpstream();
  const lines = [];
  const log = { log: (...a) => lines.push(a.join(' ')), warn() {}, error() {} };
  const relay = createRelay({ port, stateDir: path.join(up.home, 'state'), tapDir: up.tapDir, log, pendingSyncMs: 60, autoAllow: () => true });
  await relay.start();
  let ws = null;
  try {
    await waitFor(() => relay.status().upstreams === 1);
    // The wrapper's own list still holds an old permission and a question when the relay connects.
    up.answer('tap/pending', () => ({ pending: [
      { id: 'req-1', method: 'interaction/requestPermission', params: { sessionId: 'sess_a', toolName: 'Bash', input: { command: 'secret command' } }, at: Date.now() },
      { id: 'q-1', method: 'interaction/requestUserInput', params: { sessionId: 'sess_a' }, at: Date.now() },
    ] }));
    await waitFor(() => up.received.some(m => m.method === 'tap/respond'));
    assert.deepEqual(up.received.filter(m => m.method === 'tap/respond').map(m => m.params), [
      { id: 'req-1', result: { decision: 'allow', reason: 'Approved automatically by Zode' } },   // the question is never answered
    ]);

    const { token } = await (await pair(port, relay.createPairing().code, 'phone')).json();
    const phone = await authed(`ws://127.0.0.1:${port}`, token);
    ws = phone.ws;
    assert.deepEqual(phone.ready.pending.map(p => p.id), ['q-1']);      // the answered request is not offered to phones

    // a fresh event is answered the same way; a repeat and later reconciles never answer twice
    up.send({ id: 'req-2', method: 'interaction/requestPermission', params: { sessionId: 'sess_a', toolName: 'Edit' } });
    up.send({ id: 'req-1', method: 'interaction/requestPermission', params: { sessionId: 'sess_a', toolName: 'Bash' } });
    await waitFor(() => up.received.filter(m => m.method === 'tap/respond').length >= 2);
    await sleep(200);                                                   // a couple of reconciles
    assert.deepEqual(up.received.filter(m => m.method === 'tap/respond').map(m => m.params.id), ['req-1', 'req-2']);
    const resP = nextMessage(ws, (m) => m.type === 'pending');
    ws.send(JSON.stringify({ type: 'pending' }));
    assert.deepEqual((await resP).pending.map(p => p.id), ['q-1']);     // still nothing pending but the question

    const line = lines.find(l => l.startsWith('auto-allowed '));
    assert.match(line, /^auto-allowed Bash -> \d+$/);
    assert.ok(!lines.some(l => l.includes('secret command')));          // commands are never logged
  } finally {
    try { ws?.close(); } catch {}
    await relay.stop();
    await up.close();
  }
});

test('without autoAllow (the default) permission requests stay pending as today', async () => {
  const port = await freePort();
  const up = fakeUpstream();
  const relay = createRelay({ port, stateDir: path.join(up.home, 'state'), tapDir: up.tapDir, log: silent, pendingSyncMs: 60 });
  await relay.start();
  let ws = null;
  try {
    await waitFor(() => relay.status().upstreams === 1);
    const { token } = await (await pair(port, relay.createPairing().code, 'phone')).json();
    ({ ws } = await authed(`ws://127.0.0.1:${port}`, token));
    up.answer('tap/pending', () => ({ pending: [{ id: 'p-1', method: 'interaction/requestPermission', params: { sessionId: 'sess_p', toolName: 'Edit' } }] }));
    up.send({ id: 'q-1', method: 'interaction/requestUserInput', params: { sessionId: 'sess_p' } });
    // the relay only learns p-1 at the next reconcile: ask until it shows up before asserting
    const until = async (fn, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(25); } throw new Error('condition not met in time'); };
    const askPending = async () => {
      const resP = nextMessage(ws, (m) => m.type === 'pending');
      ws.send(JSON.stringify({ type: 'pending' }));
      return (await resP).pending;
    };
    await until(async () => (await askPending()).some(p => p.id === 'p-1'));
    const pend = await askPending();
    assert.deepEqual(pend.map(p => p.id).sort(), ['p-1', 'q-1']);
    await sleep(200);                                                   // a couple of reconciles
    assert.deepEqual(up.received.filter(m => m.method === 'tap/respond'), []);   // nothing was answered
  } finally {
    try { ws?.close(); } catch {}
    await relay.stop();
    await up.close();
  }
});

test('autoAllow survives an upstream that dies mid-flight', async () => {
  const port = await freePort();
  const up = fakeUpstream();
  const relay = createRelay({ port, stateDir: path.join(up.home, 'state'), tapDir: up.tapDir, log: silent, autoAllow: () => true });
  await relay.start();
  try {
    await waitFor(() => relay.status().upstreams === 1);
    await up.sendAndDie({ id: 'req-9', method: 'interaction/requestPermission', params: { sessionId: 'sess_x', toolName: 'Bash' } });
    await sleep(200);                                                   // the answer races the dead socket
    assert.equal(relay.status().running, true);                         // a failed write never takes the relay down
  } finally {
    await relay.stop();
    await up.close();
  }
});

test('a phone rpc whose upstream never answers is failed after the timeout, once', async () => {
  const port = await freePort();
  const up = fakeUpstream();
  const relay = createRelay({ port, stateDir: path.join(up.home, 'state'), tapDir: up.tapDir, rpcTimeoutMs: 120, log: silent });
  await relay.start();
  try {
    await waitFor(() => relay.status().upstreams === 1);
    const { token } = await (await pair(port, relay.createPairing().code, 'phone')).json();
    const { ws } = await authed(`ws://127.0.0.1:${port}`, token);

    ws.send(JSON.stringify({ type: 'rpc', id: 61, method: 'session/read', params: { sessionId: 'sess_slow' } }));
    await waitFor(() => up.received.length === 1);                       // forwarded upstream, which never answers
    const res = await nextMessage(ws, (m) => m.type === 'rpc-result' && m.id === 61);
    assert.equal(res.error.code, -32013);
    assert.match(res.error.message, /timed out/);
    await sleep(150);
    assert.equal(up.received.length, 1);                                 // no retry, no further traffic
    ws.close();
  } finally { await relay.stop(); await up.close(); }
});

test('an upstream closing fails the phone routes waiting on it', async () => {
  const port = await freePort();
  const up = fakeUpstream();
  const relay = createRelay({ port, stateDir: path.join(up.home, 'state'), tapDir: up.tapDir, rpcTimeoutMs: 5000, log: silent });
  await relay.start();
  try {
    await waitFor(() => relay.status().upstreams === 1);
    const { token } = await (await pair(port, relay.createPairing().code, 'phone')).json();
    const { ws } = await authed(`ws://127.0.0.1:${port}`, token);

    ws.send(JSON.stringify({ type: 'rpc', id: 62, method: 'session/read', params: { sessionId: 'sess_dying' } }));
    await waitFor(() => up.received.length === 1);                       // pending, no answer yet
    await up.close();                                                    // the upstream socket dies mid-flight
    const res = await nextMessage(ws, (m) => m.type === 'rpc-result' && m.id === 62);
    assert.equal(res.error.code, -32013);
    assert.match(res.error.message, /closed/);
    assert.equal(relay.status().upstreams, 0);
    ws.close();
  } finally { await relay.stop(); await up.close(); }
});

test('askRisky keeps the destructive ones waiting while auto-allow handles the rest', async () => {
  const port = await freePort();
  const up = fakeUpstream();
  const relay = createRelay({ port, stateDir: path.join(up.home, 'state'), tapDir: up.tapDir, log: silent, pendingSyncMs: 60, autoAllow: () => true, askRisky: () => true });
  await relay.start();
  let ws = null;
  try {
    await waitFor(() => relay.status().upstreams === 1);
    up.answer('tap/pending', () => ({ pending: [] }));
    const { token } = await (await pair(port, relay.createPairing().code, 'phone')).json();
    ({ ws } = await authed(`ws://127.0.0.1:${port}`, token));
    up.send({ id: 'risky-1', method: 'interaction/requestPermission', params: { sessionId: 'sess_r', toolName: 'Bash', riskLevel: 'high', input: { command: 'rm -rf /tmp/x' } } });
    up.send({ id: 'safe-1', method: 'interaction/requestPermission', params: { sessionId: 'sess_r', toolName: 'Bash', riskLevel: 'low', input: { command: 'npm test' } } });
    await waitFor(() => up.received.some(m => m.method === 'tap/respond' && m.params.id === 'safe-1'));
    await sleep(200);                                                   // a couple of reconciles
    assert.deepEqual(up.received.filter(m => m.method === 'tap/respond').map(m => m.params.id), ['safe-1']);   // the risky one waits
    const resP = nextMessage(ws, (m) => m.type === 'pending');
    ws.send(JSON.stringify({ type: 'pending' }));
    assert.deepEqual((await resP).pending.map(p => p.id), ['risky-1']); // and it is offered to phones as pending
    // with askRisky off (the default) even the destructive one is answered at once
    const port2 = await freePort();
    const up2 = fakeUpstream();
    const relay2 = createRelay({ port: port2, stateDir: path.join(up2.home, 'state'), tapDir: up2.tapDir, log: silent, autoAllow: () => true });
    try {
      await relay2.start();
      await waitFor(() => relay2.status().upstreams === 1);
      up2.send({ id: 'risky-2', method: 'interaction/requestPermission', params: { sessionId: 'sess_r', toolName: 'Bash', riskLevel: 'high', input: { command: 'rm -rf /tmp/x' } } });
      up2.send({ id: 'safe-2', method: 'interaction/requestPermission', params: { sessionId: 'sess_r', toolName: 'Bash', riskLevel: 'low', input: { command: 'npm test' } } });
      await waitFor(() => up2.received.filter(m => m.method === 'tap/respond').length >= 2);
      assert.deepEqual(up2.received.filter(m => m.method === 'tap/respond').map(m => m.params.id).sort(), ['risky-2', 'safe-2']);
    } finally {
      await relay2.stop();
      await up2.close();
    }
  } finally {
    try { ws?.close(); } catch {}
    await relay.stop();
    await up.close();
  }
});

test('push: pairing hands out a key, the phone registers, and notifyDevices follows the rules', async () => {
  const sent = [];
  const pusher = {
    activeWindowMs: 30000,
    send: async (device, note) => { sent.push({ device, note }); return { ok: true }; },
  };
  const port = await freePort();
  const up = fakeUpstream();
  const relay = createRelay({ port, stateDir: path.join(up.home, 'state'), tapDir: up.tapDir, log: silent, push: pusher, pushDelayMs: 30 });
  await relay.start();
  let ws = null;
  try {
    await waitFor(() => relay.status().upstreams === 1);
    const p = relay.createPairing();
    const paired = await (await pair(port, p.code, 'phone')).json();
    assert.match(paired.pushKey, /^[A-Za-z0-9_-]{43}$/);                // 32 bytes, base64url
    const devs = relay.listDevices();
    assert.equal('pushKey' in devs[0], false);                          // the key never leaves the record
    assert.equal('push' in devs[0], false);
    const conn = await authed(`ws://127.0.0.1:${port}`, paired.token);
    ws = conn.ws;
    assert.deepEqual(conn.ready.features, { stt: false, push: true });

    ws.send(JSON.stringify({ type: 'rpc', id: 200, method: 'push/register', params: { pushId: 'P'.repeat(30), secret: 'S'.repeat(30), env: 'production' } }));
    assert.deepEqual((await nextMessage(ws, (m) => m.type === 'rpc-result' && m.id === 200)).result, { ok: true });

    // the phone is authed and just talked: a done is skipped, an ask always goes out
    assert.deepEqual(await relay.notifyDevices({ kind: 'done', title: 'p', body: 'Done' }), { sent: 0, skipped: 1, gone: 0 });
    assert.deepEqual(await relay.notifyDevices({ kind: 'ask', title: 'p', body: 'Run: npm test', session: 'sess1', req: { server: 1, id: 2 } }),
      { sent: 1, skipped: 0, gone: 0 });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].device.pushKey, paired.pushKey);
    assert.deepEqual([sent[0].note.kind, sent[0].note.req], ['ask', { server: 1, id: 2 }]);

    // a pending permission from upstream pushes once, after the delay, with the shared summary
    up.send({ id: 'req-77', method: 'interaction/requestPermission', params: { sessionId: 'sess_a', toolName: 'Bash', input: { command: 'npm test' } } });
    await waitFor(() => sent.length === 2);
    await sleep(100);
    assert.equal(sent.length, 2);                                       // exactly once
    assert.deepEqual([sent[1].note.kind, sent[1].note.body], ['ask', 'Run: npm test']);
    assert.equal(sent[1].note.title, 'fake-workspace');                 // the project: the upstream folder's basename
    assert.deepEqual(sent[1].note.req, { server: process.pid, id: 'req-77' });
    assert.equal(sent[1].note.session, 'sess_a');
  } finally {
    try { ws?.close(); } catch {}
    await relay.stop();
    await up.close();
  }
});

test('push: a phone without a key gets no-push-key; unregister stops the pushes; answered first never pushes', async () => {
  const sent = [];
  const pusher = { activeWindowMs: 30000, send: async (device, note) => { sent.push({ device, note }); return { ok: true }; } };
  const port = await freePort();
  const up = fakeUpstream();
  const stateDir = path.join(up.home, 'state');
  const legacyToken = 'legacy-token';
  const relay = createRelay({ port, stateDir, tapDir: up.tapDir, log: silent, push: pusher, pushDelayMs: 40 });
  await relay.start();
  let ws = null;
  try {
    // a device paired before push existed: no key in its record
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'devices.json'), JSON.stringify([
      { id: 'legacy', name: 'old phone', tokenHash: crypto.createHash('sha256').update(legacyToken).digest('hex'), pairedAt: 1 },
    ]));
    await waitFor(() => relay.status().upstreams === 1);
    ({ ws } = await authed(`ws://127.0.0.1:${port}`, legacyToken));
    ws.send(JSON.stringify({ type: 'rpc', id: 210, method: 'push/register', params: { pushId: 'P'.repeat(30), secret: 'S'.repeat(30), env: 'production' } }));
    const refused = await nextMessage(ws, (m) => m.type === 'rpc-result' && m.id === 210);
    assert.equal(refused.error.code, -32021);
    assert.match(refused.error.message, /no-push-key/);

    // a phone with a key registers, then unregisters: the pushes stop
    const p = relay.createPairing();
    const paired = await (await pair(port, p.code, 'new phone')).json();
    const second = await authed(`ws://127.0.0.1:${port}`, paired.token);
    ws = second.ws;
    ws.send(JSON.stringify({ type: 'rpc', id: 211, method: 'push/register', params: { pushId: 'P'.repeat(30), secret: 'S'.repeat(30), env: 'sandbox' } }));
    assert.deepEqual((await nextMessage(ws, (m) => m.type === 'rpc-result' && m.id === 211)).result, { ok: true });
    assert.deepEqual(await relay.notifyDevices({ kind: 'ask', title: 'p', body: 'x' }), { sent: 1, skipped: 0, gone: 0 });
    ws.send(JSON.stringify({ type: 'rpc', id: 212, method: 'push/unregister', params: {} }));
    assert.deepEqual((await nextMessage(ws, (m) => m.type === 'rpc-result' && m.id === 212)).result, { ok: true });
    assert.deepEqual(await relay.notifyDevices({ kind: 'ask', title: 'p', body: 'x' }), { sent: 0, skipped: 0, gone: 0 });

    // a permission that is answered (or auto-allowed) inside the delay window never pushes
    up.send({ id: 'req-88', method: 'interaction/requestPermission', params: { sessionId: 'sess_a', toolName: 'Bash', input: { command: 'npm run build' } } });
    await sleep(10);                                                    // the push is scheduled but has not fired
    up.send({ method: 'tap/resolved', params: { id: 'req-88' } });
    await sleep(150);                                                   // well past pushDelayMs
    assert.equal(sent.length, 1);                                       // only the pre-unregister ask
  } finally {
    try { ws?.close(); } catch {}
    await relay.stop();
    await up.close();
  }
});

test('push: a gone answer clears the registration until the phone re-registers', async () => {
  let answer = { gone: true };
  const pusher = { activeWindowMs: 30000, send: async () => answer };
  const port = await freePort();
  const up = fakeUpstream();
  const relay = createRelay({ port, stateDir: path.join(up.home, 'state'), tapDir: up.tapDir, log: silent, push: pusher, pushDelayMs: 30 });
  await relay.start();
  let ws = null;
  try {
    await waitFor(() => relay.status().upstreams === 1);
    const paired = await (await pair(port, relay.createPairing().code, 'phone')).json();
    ({ ws } = await authed(`ws://127.0.0.1:${port}`, paired.token));
    ws.send(JSON.stringify({ type: 'rpc', id: 220, method: 'push/register', params: { pushId: 'P'.repeat(30), secret: 'S'.repeat(30), env: 'production' } }));
    await nextMessage(ws, (m) => m.type === 'rpc-result' && m.id === 220);
    assert.deepEqual(await relay.notifyDevices({ kind: 'failed', title: 'p', body: 'x' }), { sent: 0, skipped: 0, gone: 1 });
    assert.deepEqual(await relay.notifyDevices({ kind: 'failed', title: 'p', body: 'x' }), { sent: 0, skipped: 0, gone: 0 });   // nothing left to try
    answer = { ok: true };                                              // the phone re-registered after reopening the app
    ws.send(JSON.stringify({ type: 'rpc', id: 221, method: 'push/register', params: { pushId: 'Q'.repeat(30), secret: 'S'.repeat(30), env: 'production' } }));
    await nextMessage(ws, (m) => m.type === 'rpc-result' && m.id === 221);
    assert.deepEqual(await relay.notifyDevices({ kind: 'failed', title: 'p', body: 'x' }), { sent: 1, skipped: 0, gone: 0 });
  } finally {
    try { ws?.close(); } catch {}
    await relay.stop();
    await up.close();
  }
});

test('checkPolicy: rename/upload session ids, upload file rules, send attachments, usage ranges, no raw commands', () => {
  const id100 = 'sess_' + 'x'.repeat(95);                              // exactly 100 characters
  const png = { fileName: 'a.png', mime: 'image/png', dataBase64: Buffer.from('hello').toString('base64') };
  const att = { ref: 'zcode-artifact://sess_a/tool-result-1', fileName: 'a.png', mime: 'image/png', bytes: 10 };

  assert.equal(checkPolicy('session/rename', { sessionId: id100, title: '  Renamed  ' }), null);
  assert.match(checkPolicy('session/rename', { sessionId: 'nope', title: 'x' }), /sessionId/);
  assert.match(checkPolicy('session/rename', { sessionId: id100 + 'x', title: 'x' }), /sessionId/);            // 101 characters
  assert.match(checkPolicy('session/rename', { sessionId: id100, title: '   ' }), /title/);
  assert.match(checkPolicy('session/rename', { sessionId: id100, title: 'x'.repeat(121) }), /title/);

  assert.equal(checkPolicy('attachment/upload', { sessionId: id100, ...png }), null);
  assert.match(checkPolicy('attachment/upload', { sessionId: 'nope', ...png }), /sessionId/);
  assert.match(checkPolicy('attachment/upload', { sessionId: id100, fileName: '', mime: 'image/png', dataBase64: png.dataBase64 }), /fileName/);
  assert.match(checkPolicy('attachment/upload', { sessionId: id100, fileName: 'x'.repeat(201), mime: 'image/png', dataBase64: png.dataBase64 }), /fileName/);
  assert.equal(checkPolicy('attachment/upload', { sessionId: id100, fileName: 'a/b/c.png', mime: 'image/png', dataBase64: png.dataBase64 }), null);   // a directory part is reduced, not refused
  assert.match(checkPolicy('attachment/upload', { sessionId: id100, fileName: '..', mime: 'image/png', dataBase64: png.dataBase64 }), /fileName/);   // nothing safe remains
  assert.match(checkPolicy('session/send', { sessionId: 'sess_a', content: 'hi', attachments: [{ ...att, fileName: '..' }] }), /fileName/);
  assert.match(checkPolicy('attachment/upload', { sessionId: id100, fileName: 'a.png', mime: 'not a mime', dataBase64: png.dataBase64 }), /mime/);
  assert.match(checkPolicy('attachment/upload', { sessionId: id100, fileName: 'a.png', mime: 'Image/PNG', dataBase64: png.dataBase64 }), /mime/);   // lowercase only
  assert.match(checkPolicy('attachment/upload', { sessionId: id100, fileName: 'a.png', mime: 'image/png', dataBase64: '' }), /dataBase64/);
  assert.match(checkPolicy('attachment/upload', { sessionId: id100, fileName: 'a.png', mime: 'image/png', dataBase64: Buffer.alloc(8 * 1024 * 1024 + 1).toString('base64') }), /larger than 8 MB/);

  assert.equal(checkPolicy('session/send', { sessionId: 'sess_a', content: 'hi', attachments: [att] }), null);
  assert.match(checkPolicy('session/send', { sessionId: 'sess_a', content: 'hi', attachments: Array(7).fill(att) }), /at most 6/);
  assert.match(checkPolicy('session/send', { sessionId: 'sess_b', content: 'hi', attachments: [att] }), /ref/);
  assert.match(checkPolicy('session/send', { sessionId: 'sess_a', content: 'hi', attachments: [{ ...att, bytes: 0 }] }), /bytes/);
  assert.match(checkPolicy('session/send', { sessionId: 'sess_a', attachments: [att] }), /content/);

  for (const range of ['all', '7d', '30d']) assert.equal(checkPolicy('usage/stats', { range }), null);
  assert.match(checkPolicy('usage/stats', {}), /range/);
  assert.equal(checkPolicy('v4/command', {}), 'method not allowed: v4/command');
  assert.equal(checkPolicy('session/delete', { sessionId: 'sess_x' }), 'method not allowed: session/delete');
});

test('session/rename resumes the session upstream, then sends the relay-built renameSession command', async () => {
  const port = await freePort();
  const up = fakeUpstream();
  const lines = [];
  const log = { log: (...a) => lines.push(a.join(' ')), warn() {}, error() {} };
  const relay = createRelay({ port, stateDir: path.join(up.home, 'state'), tapDir: up.tapDir, log });
  await relay.start();
  try {
    await waitFor(() => relay.status().upstreams === 1);
    const { id: device, token } = await (await pair(port, relay.createPairing().code, 'phone')).json();
    const { ws } = await authed(`ws://127.0.0.1:${port}`, token);

    ws.send(JSON.stringify({ type: 'rpc', id: 7, method: 'session/rename', params: { sessionId: 'sess_abc123', title: '  New name  ' } }));
    await waitFor(() => up.received.length > 1);
    assert.equal(up.received[0].method, 'session/resume');               // the command needs an active session
    assert.deepEqual(up.received[0].params, { sessionId: 'sess_abc123' });
    const ren = up.received[1];
    assert.equal(ren.method, 'v4/command');
    assert.deepEqual(Object.keys(ren.params).sort(), ['clientId', 'commandId', 'issuedAt', 'payload', 'sessionId', 'type']);   // relay-built: nothing else leaks in
    assert.equal(ren.params.clientId, 'zode-relay');
    assert.equal(ren.params.sessionId, 'sess_abc123');
    assert.equal(ren.params.type, 'renameSession');
    assert.deepEqual(ren.params.payload, { title: 'New name' });         // the trimmed title
    up.respond(ren, { commandId: ren.params.commandId, status: 'rejected', reasonCode: 'proto.sessionNotFound', revisionAtDecision: 0 });
    const res = await nextMessage(ws, (m) => m.type === 'rpc-result' && m.id === 7);
    assert.deepEqual(res.result, { commandId: ren.params.commandId, status: 'rejected', reasonCode: 'proto.sessionNotFound', revisionAtDecision: 0 });
    assert.ok(lines.includes(`rename ${device} sess_abc123`));
    ws.close();
  } finally { await relay.stop(); await up.close(); }
});

test('a phone cannot send v4/command itself', async () => {
  const port = await freePort();
  const up = fakeUpstream();
  const relay = createRelay({ port, stateDir: path.join(up.home, 'state'), tapDir: up.tapDir, log: silent });
  await relay.start();
  try {
    await waitFor(() => relay.status().upstreams === 1);
    const { token } = await (await pair(port, relay.createPairing().code, 'phone')).json();
    const { ws } = await authed(`ws://127.0.0.1:${port}`, token);

    ws.send(JSON.stringify({ type: 'rpc', id: 9, method: 'v4/command',
      params: { commandId: 'forged', clientId: 'phone', sessionId: 'sess_abc', type: 'deleteSession', payload: {}, issuedAt: Date.now() } }));
    const res = await nextMessage(ws, (m) => m.type === 'rpc-result' && m.id === 9);
    assert.equal(res.error.code, -32001);
    assert.equal(res.error.message, 'method not allowed: v4/command');
    await sleep(150);
    assert.deepEqual(up.received, []);
    ws.close();
  } finally { await relay.stop(); await up.close(); }
});

test('usage/stats needs range all/7d/30d and is forwarded unchanged; setModel, setThoughtLevel and session/usage pass through', async () => {
  const port = await freePort();
  const up = fakeUpstream();
  const relay = createRelay({ port, stateDir: path.join(up.home, 'state'), tapDir: up.tapDir, log: silent });
  await relay.start();
  try {
    await waitFor(() => relay.status().upstreams === 1);
    const { token } = await (await pair(port, relay.createPairing().code, 'phone')).json();
    const { ws } = await authed(`ws://127.0.0.1:${port}`, token);

    ws.send(JSON.stringify({ type: 'rpc', id: 11, method: 'usage/stats', params: { range: '7d' } }));
    await waitFor(() => up.received.length > 0);
    assert.equal(up.received[0].method, 'usage/stats');
    assert.deepEqual(up.received[0].params, { range: '7d' });            // untouched
    up.respond(up.received[0], { sessions: 3, costUsd: 1.5 });
    const res = await nextMessage(ws, (m) => m.type === 'rpc-result' && m.id === 11);
    assert.deepEqual(res.result, { sessions: 3, costUsd: 1.5 });

    for (const [id, params] of [[12, {}], [13, { range: '90d' }]]) {
      ws.send(JSON.stringify({ type: 'rpc', id, method: 'usage/stats', params }));
      const bad = await nextMessage(ws, (m) => m.type === 'rpc-result' && m.id === id);
      assert.equal(bad.error.code, -32001);
      assert.match(bad.error.message, /range/);
    }

    const passthrough = [                                                // already-allowed methods: params untouched
      { id: 14, method: 'session/setModel', params: { sessionId: 'sess_a', model: 'glm-5' } },
      { id: 15, method: 'session/setThoughtLevel', params: { sessionId: 'sess_a', thoughtLevel: 'high' } },
      { id: 16, method: 'session/usage', params: { sessionId: 'sess_a' } },
    ];
    for (let i = 0; i < passthrough.length; i++) {
      ws.send(JSON.stringify({ type: 'rpc', ...passthrough[i] }));
      await waitFor(() => up.received.length > i + 1);
      assert.equal(up.received[i + 1].method, passthrough[i].method);
      assert.deepEqual(up.received[i + 1].params, passthrough[i].params);
      up.respond(up.received[i + 1], { ok: true });
      const ok = await nextMessage(ws, (m) => m.type === 'rpc-result' && m.id === passthrough[i].id);
      assert.deepEqual(ok.result, { ok: true });
    }
    ws.close();
  } finally { await relay.stop(); await up.close(); }
});

test('attachment/upload resumes, stages the chunks in order, commits and answers {ref, fileName, mime, bytes}', async () => {
  const port = await freePort();
  const up = fakeUpstream();
  const relay = createRelay({ port, stateDir: path.join(up.home, 'state'), tapDir: up.tapDir, log: silent });
  await relay.start();
  try {
    await waitFor(() => relay.status().upstreams === 1);
    const { id: device, token } = await (await pair(port, relay.createPairing().code, 'phone')).json();
    const { ws } = await authed(`ws://127.0.0.1:${port}`, token);

    const raw = Buffer.alloc(300 * 1024);                                // two 256 KiB chunks
    for (let i = 0; i < raw.length; i++) raw[i] = i % 251;
    const ref = 'zcode-artifact://sess_up1/tool-result-1234';
    up.answer('v4/attachment/commit', () => ({ ref }));
    ws.send(JSON.stringify({ type: 'rpc', id: 21, method: 'attachment/upload',
      params: { sessionId: 'sess_up1', fileName: 'a/b\nc.png', mime: 'image/png', dataBase64: raw.toString('base64') } }));
    const res = await nextMessage(ws, (m) => m.type === 'rpc-result' && m.id === 21);
    assert.deepEqual(res.result, { ref, fileName: 'bc.png', mime: 'image/png', bytes: 300 * 1024 });   // basename; control characters dropped

    await waitFor(() => up.received.length >= 5);
    const [resume, begin, chunk0, chunk1, commit] = up.received;
    assert.equal(resume.method, 'session/resume');                       // staging needs an active session
    assert.deepEqual(resume.params, { sessionId: 'sess_up1' });
    assert.equal(begin.method, 'v4/attachment/begin');
    assert.equal(begin.params.connectionId, `relay-${device}`);
    assert.equal(begin.params.sessionId, 'sess_up1');
    assert.equal(begin.params.fileName, 'bc.png');                       // directory part stripped, control characters dropped
    assert.equal(begin.params.mime, 'image/png');
    assert.equal(begin.params.totalBytes, 300 * 1024);
    assert.equal(begin.params.totalChunks, 2);
    assert.match(begin.params.checksum, /^sha256:[0-9a-f]{64}$/);
    assert.equal(begin.params.checksum, 'sha256:' + crypto.createHash('sha256').update(raw).digest('hex'));
    assert.equal(begin.params.uploadId, chunk0.params.uploadId);
    assert.equal(chunk0.params.uploadId, chunk1.params.uploadId);
    assert.equal(chunk1.params.uploadId, commit.params.uploadId);
    assert.equal(chunk0.params.connectionId, `relay-${device}`);
    assert.equal(chunk0.params.chunkIndex, 0);
    assert.equal(chunk1.params.chunkIndex, 1);
    assert.deepEqual(Buffer.concat([Buffer.from(chunk0.params.dataBase64, 'base64'), Buffer.from(chunk1.params.dataBase64, 'base64')]), raw);
    assert.equal(commit.method, 'v4/attachment/commit');
    assert.deepEqual(Object.keys(commit.params).sort(), ['connectionId', 'sessionId', 'uploadId']);
    ws.close();
  } finally { await relay.stop(); await up.close(); }
});

test('attachment/upload: too large or bad mime is refused by policy, nothing reaches upstream', async () => {
  const port = await freePort();
  const up = fakeUpstream();
  const relay = createRelay({ port, stateDir: path.join(up.home, 'state'), tapDir: up.tapDir, log: silent });
  await relay.start();
  try {
    await waitFor(() => relay.status().upstreams === 1);
    const { token } = await (await pair(port, relay.createPairing().code, 'phone')).json();
    const { ws } = await authed(`ws://127.0.0.1:${port}`, token);

    const tooBig = Buffer.alloc(8 * 1024 * 1024 + 1).toString('base64');
    ws.send(JSON.stringify({ type: 'rpc', id: 31, method: 'attachment/upload',
      params: { sessionId: 'sess_big', fileName: 'big.bin', mime: 'application/octet-stream', dataBase64: tooBig } }));
    const big = await nextMessage(ws, (m) => m.type === 'rpc-result' && m.id === 31);
    assert.equal(big.error.code, -32001);
    assert.match(big.error.message, /larger than 8 MB/);

    ws.send(JSON.stringify({ type: 'rpc', id: 32, method: 'attachment/upload',
      params: { sessionId: 'sess_x', fileName: 'a.txt', mime: 'not a mime', dataBase64: Buffer.from('hello').toString('base64') } }));
    const mime = await nextMessage(ws, (m) => m.type === 'rpc-result' && m.id === 32);
    assert.equal(mime.error.code, -32001);
    assert.match(mime.error.message, /mime/);

    await sleep(150);
    assert.deepEqual(up.received, []);                                   // nothing was forwarded
    ws.close();
  } finally { await relay.stop(); await up.close(); }
});

test('file names reduce to a safe basename on both paths; a name with nothing safe is refused', async () => {
  const port = await freePort();
  const up = fakeUpstream();
  const relay = createRelay({ port, stateDir: path.join(up.home, 'state'), tapDir: up.tapDir, log: silent });
  await relay.start();
  try {
    await waitFor(() => relay.status().upstreams === 1);
    const { token } = await (await pair(port, relay.createPairing().code, 'phone')).json();
    const { ws } = await authed(`ws://127.0.0.1:${port}`, token);
    const small = Buffer.from('hello').toString('base64');
    const ref = 'zcode-artifact://sess_nm1/tool-result-1';

    up.answer('v4/attachment/commit', () => ({ ref }));
    ws.send(JSON.stringify({ type: 'rpc', id: 41, method: 'attachment/upload',
      params: { sessionId: 'sess_nm1', fileName: 'dir/sub\\..\\report.pdf', mime: 'image/png', dataBase64: small } }));
    const upload = await nextMessage(ws, (m) => m.type === 'rpc-result' && m.id === 41);
    assert.equal(upload.error, undefined);
    assert.equal(upload.result.fileName, 'report.pdf');                  // every separator starts a new name: the last one wins
    await waitFor(() => up.received.length >= 4);
    assert.equal(up.received.find((m) => m.method === 'v4/attachment/begin').params.fileName, 'report.pdf');

    up.received.length = 0;
    up.answer('v4/command', (m) => ({ commandId: m.params.commandId, status: 'accepted' }));
    ws.send(JSON.stringify({ type: 'rpc', id: 42, method: 'session/send',
      params: { sessionId: 'sess_nm1', content: 'hi', attachments: [{ ref, fileName: '../out/../pic.png', mime: 'image/png', bytes: 1 }] } }));
    const send = await nextMessage(ws, (m) => m.type === 'rpc-result' && m.id === 42);
    assert.equal(send.error, undefined);
    await waitFor(() => up.received.some((m) => m.method === 'v4/command'));
    assert.deepEqual(up.received.find((m) => m.method === 'v4/command').params.payload.attachments,
      [{ ref, fileName: 'pic.png', mime: 'image/png', bytes: 1 }]);

    const bad = ['..', '.', '///', '\\\\', '\u0000\u0001', '   ', 'x'.repeat(201)];   // nothing safe remains
    let id = 43;
    const before = up.received.length;
    for (const name of bad) {
      ws.send(JSON.stringify({ type: 'rpc', id, method: 'attachment/upload',
        params: { sessionId: 'sess_nm1', fileName: name, mime: 'image/png', dataBase64: small } }));
      assert.equal((await nextMessage(ws, (m) => m.type === 'rpc-result' && m.id === id)).error.code, -32001, JSON.stringify(name));
      id += 1;
      ws.send(JSON.stringify({ type: 'rpc', id, method: 'session/send',
        params: { sessionId: 'sess_nm1', content: 'hi', attachments: [{ ref, fileName: name, mime: 'image/png', bytes: 1 }] } }));
      assert.equal((await nextMessage(ws, (m) => m.type === 'rpc-result' && m.id === id)).error.code, -32001, JSON.stringify(name));
      id += 1;
    }
    await sleep(150);
    assert.equal(up.received.length, before);                            // none of the refused names reached upstream
    ws.close();
  } finally { await relay.stop(); await up.close(); }
});

test('session/send with attachments sends exactly one sendText v4/command; a foreign ref is refused', async () => {
  const port = await freePort();
  const up = fakeUpstream();
  const relay = createRelay({ port, stateDir: path.join(up.home, 'state'), tapDir: up.tapDir, log: silent });
  await relay.start();
  try {
    await waitFor(() => relay.status().upstreams === 1);
    const { token } = await (await pair(port, relay.createPairing().code, 'phone')).json();
    const { ws } = await authed(`ws://127.0.0.1:${port}`, token);

    up.answer('v4/command', (m) => ({ commandId: m.params.commandId, status: 'accepted', result: { type: 'inputAccepted', delivery: 'startNow', inputId: 'in_1' } }));
    const att = { ref: 'zcode-artifact://sess_s1/tool-result-9', fileName: 'pics/pic.png', mime: 'image/png', bytes: 1234, bogus: 'dropped' };
    const resP = nextMessage(ws, (m) => m.type === 'rpc-result' && m.id === 41);   // listen first: the fake answers v4/command within the same tick
    ws.send(JSON.stringify({ type: 'rpc', id: 41, method: 'session/send',
      params: { sessionId: 'sess_s1', content: 'look at this', attachments: [att], modelSelection: { model: 'glm-5' } } }));
    await waitFor(() => up.received.length >= 2);
    assert.equal(up.received[0].method, 'session/resume');               // the command needs an active session
    assert.equal(up.received.filter((x) => x.method === 'v4/command').length, 1);
    const cmd = up.received[1];
    assert.equal(cmd.method, 'v4/command');
    assert.equal(cmd.params.type, 'sendText');
    assert.equal(cmd.params.clientId, 'zode-relay');
    assert.equal(cmd.params.sessionId, 'sess_s1');
    assert.equal(typeof cmd.params.issuedAt, 'number');
    assert.deepEqual(cmd.params.payload, { text: 'look at this',
      attachments: [{ ref: att.ref, fileName: 'pic.png', mime: 'image/png', bytes: 1234 }],   // reduced to the basename, never the phone's raw name
      modelSelection: { model: 'glm-5' } });
    const res = await resP;
    assert.deepEqual(res.result, { accepted: true, sessionId: 'sess_s1',
      command: { commandId: cmd.params.commandId, status: 'accepted', result: { type: 'inputAccepted', delivery: 'startNow', inputId: 'in_1' } } });

    up.answer('v4/command', () => ({ status: 'rejected', reasonCode: 'proto.sessionNotFound' }));
    const badP = nextMessage(ws, (m) => m.type === 'rpc-result' && m.id === 42);   // listen first, same reason
    ws.send(JSON.stringify({ type: 'rpc', id: 42, method: 'session/send',
      params: { sessionId: 'sess_s1', content: 'again', attachments: [{ ref: 'zcode-artifact://sess_s1/tool-result-9', fileName: 'pic.png', mime: 'image/png', bytes: 1234 }] } }));
    await waitFor(() => up.received.length >= 4);
    const bad = await badP;
    assert.equal(bad.error.code, -32010);
    assert.equal(bad.error.message, 'proto.sessionNotFound');

    const foreign = { ref: 'zcode-artifact://sess_OTHER/tool-result-9', fileName: 'pic.png', mime: 'image/png', bytes: 1234 };
    ws.send(JSON.stringify({ type: 'rpc', id: 43, method: 'session/send', params: { sessionId: 'sess_s1', content: 'hi', attachments: [foreign] } }));
    const refRes = await nextMessage(ws, (m) => m.type === 'rpc-result' && m.id === 43);
    assert.equal(refRes.error.code, -32001);
    assert.match(refRes.error.message, /ref/);

    await sleep(150);
    assert.equal(up.received.filter((x) => x.method === 'v4/command').length, 2);   // the refused one never went upstream
    ws.close();
  } finally { await relay.stop(); await up.close(); }
});

test('session/delete was removed: a phone gets method not allowed', async () => {
  const state = tmp(), tap = tmp();
  const port = await freePort();
  const relay = createRelay({ port, stateDir: state, tapDir: tap, log: silent });
  await relay.start();
  try {
    const { token } = await (await pair(port, relay.createPairing().code, 'phone')).json();
    const { ws } = await authed(`ws://127.0.0.1:${port}`, token);
    ws.send(JSON.stringify({ type: 'rpc', id: 51, method: 'session/delete', params: { sessionId: 'sess_x' } }));
    const res = await nextMessage(ws, (m) => m.type === 'rpc-result' && m.id === 51);
    assert.equal(res.error.code, -32001);
    assert.equal(res.error.message, 'method not allowed: session/delete');
    ws.close();
  } finally { await relay.stop(); rm(state, tap); }
});

// ---- stt/transcribe and stt/status ------------------------------------------------------------

const goodAudio = Buffer.from('abc').toString('base64');   // 'YWJj'

test('stt/transcribe: the relay answers itself, the host gets the exact bytes, nothing is forwarded', async () => {
  const port = await freePort();
  const up = fakeUpstream();
  const stt = fakeStt();
  const lines = [];
  const log = { log: (...a) => lines.push(a.join(' ')), warn() {}, error() {} };
  const relay = createRelay({ port, stateDir: path.join(up.home, 'state'), tapDir: up.tapDir, log, stt });
  await relay.start();
  try {
    await waitFor(() => relay.status().upstreams === 1);
    const { id: device, token } = await (await pair(port, relay.createPairing().code, 'phone')).json();
    const { ws, ready } = await authed(`ws://127.0.0.1:${port}`, token);
    assert.deepEqual(ready.features, { stt: true, push: true });

    const raw = Buffer.from('watch aac bytes \u00e9\u4e2d', 'utf8');
    const long = 'x'.repeat(100);
    ws.send(JSON.stringify({ type: 'rpc', id: 61, method: 'stt/transcribe', params: {
      audio: raw.toString('base64'), format: 'm4a', language: 'zh',
      hint: { projects: [long, 'proj', 42, ...Array.from({ length: 25 }, (_, i) => `prj${i}`)], titles: ['', '   ', 'title one'] },
    } }));
    const res = await nextMessage(ws, (m) => m.type === 'rpc-result' && m.id === 61);
    assert.deepEqual(res.result, { ok: true, text: 'hello worktree', ms: 42, language: 'zh' });

    assert.equal(stt.calls.length, 1);
    const req = stt.calls[0].req;
    assert.ok(Buffer.isBuffer(req.audio));
    assert.deepEqual(req.audio, raw);                     // byte-for-byte what the phone sent
    assert.equal(req.format, 'm4a');
    assert.equal(req.language, 'zh');
    assert.deepEqual(req.hint.projects, ['x'.repeat(60), 'proj', ...Array.from({ length: 18 }, (_, i) => `prj${i}`)]);   // clamped, not refused
    assert.deepEqual(req.hint.titles, ['title one']);

    await sleep(150);
    assert.deepEqual(up.received.filter((m) => String(m.method).startsWith('stt/')), []);   // never forwarded upstream
    const line = lines.find((l) => l.startsWith(`stt ${device} `));
    assert.ok(line, 'one stt log line');
    assert.match(line, / \d+B lang=zh 42ms ok$/);
    assert.ok(!line.includes('worktree'));                // the transcript is never logged
    ws.close();
  } finally { await relay.stop(); await up.close(); }
});

test('stt/transcribe: bad-params and too-large answer -32020 even with no ZCode server', async () => {
  const state = tmp(), tap = tmp();
  const port = await freePort();
  const relay = createRelay({ port, stateDir: state, tapDir: tap, log: silent, stt: fakeStt() });
  await relay.start();
  try {
    const { token } = await (await pair(port, relay.createPairing().code, 'phone')).json();
    const { ws } = await authed(`ws://127.0.0.1:${port}`, token);
    const cases = [
      [62, {}, 'bad-params'],
      [63, { audio: '', format: 'wav' }, 'bad-params'],
      [64, { audio: 'not base64!!', format: 'wav' }, 'bad-params'],
      [65, { audio: goodAudio, format: 'aac' }, 'bad-params'],
      [66, { audio: goodAudio, format: 'wav', language: 'fr' }, 'bad-params'],
      [67, { audio: Buffer.alloc(3_000_001, 1).toString('base64'), format: 'wav' }, 'too-large'],
    ];
    for (const [id, params, reason] of cases) {
      ws.send(JSON.stringify({ type: 'rpc', id, method: 'stt/transcribe', params }));
      const res = await nextMessage(ws, (m) => m.type === 'rpc-result' && m.id === id);
      assert.equal(res.error.code, -32020, `id ${id}`);
      assert.equal(res.error.data.reason, reason, `id ${id}`);
    }
    ws.close();
  } finally { await relay.stop(); rm(state, tap); }
});

test('stt without a host engine: features.stt is false and both methods answer voice-off', async () => {
  const state = tmp(), tap = tmp();
  const port = await freePort();
  const relay = createRelay({ port, stateDir: state, tapDir: tap, log: silent });
  await relay.start();
  try {
    const { token } = await (await pair(port, relay.createPairing().code, 'phone')).json();
    const { ws, ready } = await authed(`ws://127.0.0.1:${port}`, token);
    assert.deepEqual(ready.features, { stt: false, push: true });
    ws.send(JSON.stringify({ type: 'rpc', id: 71, method: 'stt/transcribe', params: { audio: goodAudio, format: 'wav' } }));
    const res = await nextMessage(ws, (m) => m.type === 'rpc-result' && m.id === 71);
    assert.equal(res.error.code, -32020);
    assert.equal(res.error.data.reason, 'voice-off');
    ws.send(JSON.stringify({ type: 'rpc', id: 72, method: 'stt/status', params: {} }));
    const st = await nextMessage(ws, (m) => m.type === 'rpc-result' && m.id === 72);
    assert.equal(st.error.code, -32020);
    assert.equal(st.error.data.reason, 'voice-off');
    ws.close();
  } finally { await relay.stop(); rm(state, tap); }
});

test('stt/status: shaped from the host status; no engine or a partial model means not available', async () => {
  const state = tmp(), tap = tmp();
  const port = await freePort();
  const over = { language: 'zh' };
  const relay = createRelay({ port, stateDir: state, tapDir: tap, log: silent, stt: fakeStt(over) });
  await relay.start();
  try {
    const { token } = await (await pair(port, relay.createPairing().code, 'phone')).json();
    const { ws } = await authed(`ws://127.0.0.1:${port}`, token);
    const ask = async (id) => { ws.send(JSON.stringify({ type: 'rpc', id, method: 'stt/status', params: {} })); return nextMessage(ws, (m) => m.type === 'rpc-result' && m.id === id); };

    assert.deepEqual((await ask(74)).result, { available: true, language: 'zh', model: 'small', modelState: 'ready' });
    over.status = { engine: false, models: { small: { state: 'ready', bytes: 1 } } };
    assert.deepEqual((await ask(75)).result, { available: false, language: 'zh', model: 'small', modelState: 'ready' });
    over.status = { engine: true, models: { small: { state: 'partial', bytes: 5 } } };
    assert.deepEqual((await ask(76)).result, { available: false, language: 'zh', model: 'small', modelState: 'partial' });
    ws.close();
  } finally { await relay.stop(); rm(state, tap); }
});

test('stt/transcribe: one in flight per device — the second is rate-limited while the first runs', async () => {
  const state = tmp(), tap = tmp();
  const port = await freePort();
  let release;
  const gate = new Promise((r) => { release = r; });
  const stt = fakeStt({ transcribe: () => gate.then(() => ({ ok: true, text: 'slow transcript', ms: 5, language: 'en' })) });
  const relay = createRelay({ port, stateDir: state, tapDir: tap, log: silent, stt });
  await relay.start();
  try {
    const { token } = await (await pair(port, relay.createPairing().code, 'phone')).json();
    const { ws } = await authed(`ws://127.0.0.1:${port}`, token);
    const first = nextMessage(ws, (m) => m.type === 'rpc-result' && m.id === 81);   // listen first
    ws.send(JSON.stringify({ type: 'rpc', id: 81, method: 'stt/transcribe', params: { audio: goodAudio, format: 'wav' } }));
    await waitFor(() => stt.calls.length === 1);
    ws.send(JSON.stringify({ type: 'rpc', id: 82, method: 'stt/transcribe', params: { audio: goodAudio, format: 'wav' } }));
    const second = await nextMessage(ws, (m) => m.type === 'rpc-result' && m.id === 82);
    assert.equal(second.error.code, -32020);
    assert.equal(second.error.data.reason, 'rate-limited');
    release();
    assert.deepEqual((await first).result, { ok: true, text: 'slow transcript', ms: 5, language: 'en' });
    ws.close();
  } finally { await relay.stop(); rm(state, tap); }
});

test('stt/transcribe: at most 20 per device per minute', async () => {
  const state = tmp(), tap = tmp();
  const port = await freePort();
  const relay = createRelay({ port, stateDir: state, tapDir: tap, log: silent, stt: fakeStt() });
  await relay.start();
  try {
    const { token } = await (await pair(port, relay.createPairing().code, 'phone')).json();
    const { ws } = await authed(`ws://127.0.0.1:${port}`, token);
    for (let id = 90; id < 110; id++) {
      ws.send(JSON.stringify({ type: 'rpc', id, method: 'stt/transcribe', params: { audio: goodAudio, format: 'wav' } }));
      const res = await nextMessage(ws, (m) => m.type === 'rpc-result' && m.id === id);
      assert.equal(res.result?.ok, true, `id ${id}`);       // sequential, so the in-flight rule never trips
    }
    ws.send(JSON.stringify({ type: 'rpc', id: 110, method: 'stt/transcribe', params: { audio: goodAudio, format: 'wav' } }));
    const over = await nextMessage(ws, (m) => m.type === 'rpc-result' && m.id === 110);
    assert.equal(over.error.code, -32020);
    assert.equal(over.error.data.reason, 'rate-limited');
    ws.close();
  } finally { await relay.stop(); rm(state, tap); }
});

test('stt/transcribe: engine failures pass the engine reason through; a throwing engine is engine-failed', async () => {
  const state = tmp(), tap = tmp();
  const port = await freePort();
  const engine = { respond: async () => ({ ok: false, code: 'no-model', error: 'model small is missing' }) };
  const relay = createRelay({ port, stateDir: state, tapDir: tap, log: silent, stt: fakeStt({ transcribe: () => engine.respond() }) });
  await relay.start();
  try {
    const { token } = await (await pair(port, relay.createPairing().code, 'phone')).json();
    const { ws } = await authed(`ws://127.0.0.1:${port}`, token);
    const ask = async (id) => { ws.send(JSON.stringify({ type: 'rpc', id, method: 'stt/transcribe', params: { audio: goodAudio, format: 'wav' } })); return nextMessage(ws, (m) => m.type === 'rpc-result' && m.id === id); };

    let res = await ask(111);
    assert.equal(res.error.code, -32020);
    assert.equal(res.error.data.reason, 'no-model');
    assert.equal(res.error.message, 'model small is missing');

    engine.respond = async () => ({ ok: false, code: 'busy' });
    res = await ask(112);
    assert.equal(res.error.data.reason, 'busy');
    assert.equal(res.error.message, 'transcription failed');   // the engine gave no message

    engine.respond = async () => { throw new Error('engine exploded'); };
    res = await ask(113);
    assert.equal(res.error.data.reason, 'engine-failed');
    assert.equal(res.error.message, 'engine exploded');
    ws.close();
  } finally { await relay.stop(); rm(state, tap); }
});

// ---- the approval audit log (opts.audit) -------------------------------------------------------

const auditLines = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim());

test('audit: auto-allow records asked and allowed/auto, once per request', async () => {
  const port = await freePort();
  const up = fakeUpstream();
  const auditFile = path.join(up.home, 'approvals.jsonl');
  const audit = createAuditLog({ file: auditFile });
  const relay = createRelay({ port, stateDir: path.join(up.home, 'state'), tapDir: up.tapDir, log: silent, pendingSyncMs: 60, autoAllow: () => true, audit });
  await relay.start();
  try {
    await waitFor(() => relay.status().upstreams === 1);
    up.answer('tap/pending', () => ({ pending: [
      { id: 'req-1', method: 'interaction/requestPermission', params: { sessionId: 'sess_a', toolName: 'Bash', input: { command: 'npm test' } }, at: Date.now() },
    ] }));
    await waitFor(() => audit.recent(5).some(r => r.id.endsWith(':req-1') && r.outcome === 'allowed' && r.by === 'auto'));
    const [row] = audit.recent(5);
    assert.deepEqual({ tool: row.tool, summary: row.summary, risky: row.risky, outcome: row.outcome, by: row.by, device: row.device },
      { tool: 'Bash', summary: 'Run: npm test', risky: false, outcome: 'allowed', by: 'auto', device: null });
    assert.ok(row.askedAt > 0);

    // a fresh event is asked + decided the same way; repeats and reconciles never double-record
    up.send({ id: 'req-2', method: 'interaction/requestPermission', params: { sessionId: 'sess_a', toolName: 'Edit' } });
    await waitFor(() => audit.recent(5).filter(r => r.outcome === 'allowed').length === 2);
    await sleep(300);                                                   // a couple of reconciles
    assert.equal(auditLines(auditFile).length, 4);                      // two asked + two decided, nothing more
  } finally { await relay.stop(); await up.close(); }
});

test('audit: a phone respond records allowed/rejected with the device; a later tap/resolved adds nothing', async () => {
  const port = await freePort();
  const up = fakeUpstream();
  const auditFile = path.join(up.home, 'approvals.jsonl');
  const audit = createAuditLog({ file: auditFile });
  const relay = createRelay({ port, stateDir: path.join(up.home, 'state'), tapDir: up.tapDir, log: silent, audit });
  await relay.start();
  let ws = null;
  try {
    await waitFor(() => relay.status().upstreams === 1);
    const { token } = await (await pair(port, relay.createPairing().code, 'Test iPhone')).json();
    ({ ws } = await authed(`ws://127.0.0.1:${port}`, token));
    up.send({ id: 'req-a', method: 'interaction/requestPermission', params: { sessionId: 'sess_b', toolName: 'Bash', input: { command: 'npm test' } } });
    up.send({ id: 'req-d', method: 'interaction/requestPermission', params: { sessionId: 'sess_b', toolName: 'Bash', input: { command: 'npm run clean' } } });
    await waitFor(() => audit.recent(10).filter(r => r.outcome === 'pending').length === 2);

    ws.send(JSON.stringify({ type: 'respond', rid: 1, server: process.pid, id: 'req-a', decision: 'allow' }));
    ws.send(JSON.stringify({ type: 'respond', rid: 2, server: process.pid, id: 'req-d', decision: 'deny' }));
    await waitFor(() => audit.recent(10).filter(r => r.by === 'phone').length === 2);
    const rows = new Map(audit.recent(10).map(r => [r.id.split(':')[1], r]));
    assert.deepEqual([rows.get('req-a').outcome, rows.get('req-a').by, rows.get('req-a').device], ['allowed', 'phone', 'Test iPhone']);
    assert.deepEqual([rows.get('req-d').outcome, rows.get('req-d').by], ['rejected', 'phone']);

    // the wrapper's own resolved arrives afterwards: the phone's decision already won the id
    up.send({ method: 'tap/resolved', params: { id: 'req-a' } });
    await sleep(100);
    assert.equal(auditLines(auditFile).filter(l => l.includes(':req-a"')).length, 2);   // asked + one decided
    assert.equal(audit.recent(10).some(r => r.id.endsWith(':req-a') && r.outcome === 'cancelled'), false);
  } finally {
    try { ws?.close(); } catch {}
    await relay.stop();
    await up.close();
  }
});

test('audit: a dead socket records unavailable and the request stays pending, never allowed', async () => {
  const port = await freePort();
  const up = fakeUpstream();
  const audit = createAuditLog({ file: path.join(up.home, 'approvals.jsonl') });
  const realConnect = net.connect.bind(net);
  let relaySock = null;                                                 // the socket the relay opened to the upstream
  net.connect = (...args) => { const s = realConnect(...args); relaySock = s; return s; };
  const relay = createRelay({ port, stateDir: path.join(up.home, 'state'), tapDir: up.tapDir, log: silent, autoAllow: () => true, audit });
  await relay.start();
  let ws = null;
  try {
    await waitFor(() => relay.status().upstreams === 1 && relaySock);
    relaySock.write = () => { throw new Error('socket gone'); };        // a dead upstream: every relay write throws
    up.send({ id: 'dead-1', method: 'interaction/requestPermission', params: { sessionId: 'sess_x', toolName: 'Bash', input: { command: 'npm test' } } });
    await waitFor(() => audit.recent(5).some(r => r.id.endsWith(':dead-1') && r.outcome === 'unavailable' && r.by === 'none'));

    const { token } = await (await pair(port, relay.createPairing().code, 'phone')).json();
    ({ ws } = await authed(`ws://127.0.0.1:${port}`, token));
    const resP = nextMessage(ws, (m) => m.type === 'pending');
    ws.send(JSON.stringify({ type: 'pending' }));
    assert.ok((await resP).pending.some(p => p.id === 'dead-1'));       // still pending, waiting for a human
    assert.deepEqual(up.received.filter(m => m.method === 'tap/respond'), []);   // and never allowed
  } finally {
    net.connect = realConnect;
    try { ws?.close(); } catch {}
    await relay.stop();
    await up.close();
  }
});

test('audit: a request that vanishes from the wrapper without an answer is cancelled once', async () => {
  const port = await freePort();
  const up = fakeUpstream();
  const auditFile = path.join(up.home, 'approvals.jsonl');
  const audit = createAuditLog({ file: auditFile });
  const relay = createRelay({ port, stateDir: path.join(up.home, 'state'), tapDir: up.tapDir, log: silent, pendingSyncMs: 60, audit });
  await relay.start();
  try {
    await waitFor(() => relay.status().upstreams === 1);
    up.answer('tap/pending', () => ({ pending: [
      { id: 'van-1', method: 'interaction/requestPermission', params: { sessionId: 'sess_v', toolName: 'Bash' }, at: Date.now() - 10_000 },
    ] }));
    await waitFor(() => audit.recent(5).some(r => r.id.endsWith(':van-1') && r.outcome === 'pending'));
    up.answer('tap/pending', () => ({ pending: [] }));                  // the turn was stopped; the request vanished
    await waitFor(() => audit.recent(5).some(r => r.id.endsWith(':van-1') && r.outcome === 'cancelled' && r.by === 'none'));
    await sleep(300);                                                   // several more reconciles
    const lines = auditLines(auditFile).filter(l => l.includes(':van-1"'));
    assert.equal(lines.length, 2);                                      // one asked, exactly one decided
    assert.equal(lines.filter(l => JSON.parse(l).outcome === 'cancelled').length, 1);
  } finally { await relay.stop(); await up.close(); }
});

// ---- the static web client (opts.webDir) -------------------------------------------------------

// Raw node:http: the path reaches the relay byte for byte — fetch would normalize `..` and `\`
// client-side, and these tests exist to prove the RELAY rejects them.
const get = (port, file, method = 'GET') => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path: file, method }, (res) => {
    let text = '';
    res.setEncoding('utf8');
    res.on('data', d => { text += d; });
    res.on('end', () => resolve({ status: res.statusCode, headers: { get: k => res.headers[String(k).toLowerCase()] ?? null }, text }));
  });
  req.on('error', reject);
  req.end();
});

test('web client: index at / and on extension-less routes, files by type, 404s, headers, no CORS', async () => {
  const web = fs.mkdtempSync(path.join('/tmp', 'zode-web-'));
  fs.mkdirSync(path.join(web, '_expo'), { recursive: true });
  fs.writeFileSync(path.join(web, 'index.html'), '<html>zode</html>');
  fs.writeFileSync(path.join(web, 'app.js'), 'console.log(1)');
  fs.writeFileSync(path.join(web, '_expo', 'chunk-abc.js'), 'export 1');
  const port = await freePort();
  const up = fakeUpstream();
  const relay = createRelay({ port, stateDir: path.join(up.home, 'state'), tapDir: up.tapDir, log: silent, webDir: web });
  await relay.start();
  try {
    const home = await get(port, '/');
    assert.equal(home.status, 200);
    assert.equal(home.text, '<html>zode</html>');
    assert.equal(home.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(home.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(home.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(home.headers.get('x-frame-options'), 'DENY');
    assert.match(home.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(home.headers.get('cache-control'), 'no-cache');
    assert.equal(home.headers.get('access-control-allow-origin'), null);
    const spa = await get(port, '/conversations');                     // no extension: the app handles it
    assert.equal(spa.status, 200);
    assert.equal(spa.text, '<html>zode</html>');
    const js = await get(port, '/app.js');
    assert.equal(js.status, 200);
    assert.equal(js.headers.get('content-type'), 'text/javascript; charset=utf-8');
    const hashed = await get(port, '/_expo/chunk-abc.js');
    assert.equal(hashed.status, 200);
    assert.equal(hashed.headers.get('cache-control'), 'public, max-age=3600');
    assert.equal((await get(port, '/missing.png')).status, 404);        // extension: no fallback
    for (const bad of ['/../x', '/%2e%2e/x', '/a/..%2f..%2fx', '/x%00.html', '/a%5C..%5Cx']) {
      assert.equal((await get(port, bad)).status, 404, bad);            // %5C = the backslash case
    }
    const head = await get(port, '/', 'HEAD');
    assert.equal(head.status, 200);
    assert.equal(head.text, '');
    assert.equal(head.headers.get('content-type'), 'text/html; charset=utf-8');
    // /health and /pair are untouched
    assert.equal((await get(port, '/health')).status, 200);
    const pairRes = await fetch(`http://127.0.0.1:${port}/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'nope', name: 'x' }) });
    assert.equal(pairRes.status, 403);
  } finally { await relay.stop(); await up.close(); fs.rmSync(web, { recursive: true, force: true }); }
});

test('web client: without webDir everything but /health and /pair stays 404', async () => {
  const port = await freePort();
  const up = fakeUpstream();
  const relay = createRelay({ port, stateDir: path.join(up.home, 'state'), tapDir: up.tapDir, log: silent });
  await relay.start();
  try {
    assert.equal((await get(port, '/')).status, 404);
    assert.equal((await get(port, '/app.js')).status, 404);
    assert.equal((await get(port, '/health')).status, 200);
  } finally { await relay.stop(); await up.close(); }
});
