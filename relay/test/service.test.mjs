// The relay as an embeddable service: lifecycle, pairing, devices, per-instance isolation, upstream events.
// Port 0 is not supported (the pairing payload embeds the port), so each test asks the OS for a free port first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { createRelay } from '../service.mjs';

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

test('pairing: POST /pair returns a token; a code is one-time and expires', async () => {
  const state = tmp(), tap = tmp();
  try {
    const port = await freePort();
    const relay = createRelay({ port, stateDir: state, tapDir: tap, codeTtlMs: 200, log: silent });
    await relay.start();

    const p = relay.createPairing();
    assert.equal(p.payload, JSON.stringify({ u: `http://127.0.0.1:${port}`, w: `ws://127.0.0.1:${port}`, c: p.code }));
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
    assert.deepEqual(devs, [{ id, name: 'test-phone', pairedAt: devs[0].pairedAt }]);
    assert.deepEqual(Object.keys(devs[0]).sort(), ['id', 'name', 'pairedAt']);   // no token hash leaks

    const { ws, ready } = await authed(`ws://127.0.0.1:${port}`, token);
    assert.equal(ready.device, id);
    assert.equal(relay.status().clients, 1);
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
  const home = tmp();
  const tapDir = path.join(home, 'tap'); fs.mkdirSync(tapDir);
  const sockPath = path.join(tapDir, 'upstream.sock');
  let upSock = null;
  const fake = net.createServer((s) => {
    upSock = s; let buf = '';
    s.on('data', (d) => {
      buf += d; let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const l = buf.slice(0, i); buf = buf.slice(i + 1); if (!l.trim()) continue;
        const m = JSON.parse(l);
        if (m.method === 'tap/pending') s.write(JSON.stringify({ id: m.id, tapReply: true, result: { pending: [] } }) + '\n');
      }
    });
  });
  fake.listen(sockPath);
  // the meta file syncUpstream expects: live pid, cwd, and the unix socket path
  fs.writeFileSync(path.join(tapDir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, cwd: '/tmp/fake-workspace', sock: sockPath }));

  const port = await freePort();
  const relay = createRelay({ port, stateDir: path.join(home, 'state'), tapDir, log: silent });
  await relay.start();
  try {
    await waitFor(() => upSock !== null && relay.status().upstreams === 1);
    const { token } = await (await pair(port, relay.createPairing().code, 'phone')).json();
    const { ws, ready } = await authed(`ws://127.0.0.1:${port}`, token);
    assert.deepEqual(ready.servers, [{ pid: process.pid, cwd: '/tmp/fake-workspace' }]);

    upSock.write(JSON.stringify({ method: 'session/event', params: { sessionId: 's1', payload: { text: 'hello' } } }) + '\n');
    const evt = await nextMessage(ws, (m) => m.type === 'event');
    assert.equal(evt.server, process.pid);
    assert.equal(evt.msg.method, 'session/event');
    assert.deepEqual(evt.msg.params.payload, { text: 'hello' });
    ws.close();
  } finally {
    await relay.stop();
    fake.close();
    rm(home);
  }
});
