// handlers + serveApi: register and push end to end with fakes — validation, the sealed payload,
// size caps, auth, rate limits, the APNs answer mapping, 405, and the promise that nothing sensitive
// is ever logged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { handleRegister, handlePush, serveApi, defaultDeps, buildApnsPayload, ipOf } from '../lib/handlers.mjs';
import { apnsSend } from '../lib/apns.mjs';
import { createCodec, deriveAuthKey, authFor } from '../lib/ids.mjs';
import { fakeApns } from './helpers.mjs';
import { pushBucket, registerBucket } from '../lib/limits.mjs';

const NOW = Date.parse('2026-10-25T12:00:00Z');

function testDeps(over = {}) {
  const serverKey = crypto.randomBytes(32);
  const authKey = deriveAuthKey(serverKey);
  const fake = over.fakeApns ?? null;
  const base = {
    codec: createCodec(serverKey),
    auth: (p) => authFor(p, authKey),
    tokenSource: () => 'jwt.test',
    connect: fake ? fake.connect : async () => { throw new Error('no apns here'); },
    apnsSend: over.apnsSend ?? apnsSend,
    pushLimit: pushBucket(),
    registerLimit: registerBucket(),
    topic: 'sg.comex.zode',
    timeoutMs: 500,
    now: () => NOW,
    log: () => {},
    ip: '198.51.100.7',
    serverKey,                                                          // tests may mint their own push ids
  };
  return { ...base, ...over };
}

const fakeRes = () => ({ code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; } });
const register = (deps, over = {}) => handleRegister({ deviceToken: 'a'.repeat(64), env: 'production', ...over }, deps);

test('register: a valid phone gets a working push id and secret; junk gets 400', async () => {
  const deps = testDeps();
  const out = await register(deps);
  assert.deepEqual(out, { status: 200, body: { pushId: out.body.pushId, secret: out.body.secret } });
  assert.deepEqual(deps.codec.decrypt(out.body.pushId), { t: 'a'.repeat(64), e: 'production' });
  assert.equal(out.body.secret, deps.auth(out.body.pushId));

  for (const bad of [
    {},                                                                 // empty
    { deviceToken: 'a'.repeat(63), env: 'production' },                 // too short
    { deviceToken: 'a'.repeat(201), env: 'production' },                // too long
    { deviceToken: 'a'.repeat(63) + 'g', env: 'production' },           // not hex
    { deviceToken: 'a'.repeat(64) },                                    // no env
    { deviceToken: 'a'.repeat(64), env: 'development' },                // unknown env
    { deviceToken: 'a'.repeat(64), env: 1 },
    { deviceToken: 42, env: 'production' },
    { deviceToken: 'a'.repeat(64), env: 'production', bundleId: 7 },    // bundle id must be a string
    { deviceToken: 'a'.repeat(64), env: 'production', bundleId: '' },
    { deviceToken: 'a'.repeat(64), env: 'production', bundleId: 'b'.repeat(201) },
  ]) {
    assert.deepEqual(await handleRegister(bad, deps), { status: 400, body: { error: 'bad-request' } }, JSON.stringify(bad).slice(0, 40));
  }
  assert.equal((await register(deps, { deviceToken: 'b'.repeat(200) })).status, 200);   // 200 hex: the upper edge
});

test('push: the APNs exchange carries the sealed payload and the fixed placeholder text', async () => {
  const fake = fakeApns({ status: 200 });
  const deps = testDeps({ fakeApns: fake });
  const reg = await register(deps);
  const out = await handlePush({ pushId: reg.body.pushId, auth: reg.body.secret, kind: 'ask', sealed: 'AAA_sg', collapseId: 'z1' }, deps);
  assert.deepEqual(out, { status: 200, body: { ok: true } });
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].host, 'api.push.apple.com');
  const payload = JSON.parse(fake.calls[0].body);
  assert.deepEqual(payload.aps.alert, { title: 'Zode', body: 'Open Zode' });
  assert.equal(payload.aps['mutable-content'], 1);
  assert.equal(payload.aps.sound, 'default');
  assert.equal(payload.aps.category, 'zode.ask');
  assert.equal(payload.aps['thread-id'], 'zode');
  assert.deepEqual([payload.k, payload.s], ['ask', 'AAA_sg']);
});

test('push: kind done drops the sound and drops to priority 5', async () => {
  const fake = fakeApns({ status: 200 });
  const deps = testDeps({ fakeApns: fake });
  const reg = await register(deps, { env: 'sandbox' });
  const out = await handlePush({ pushId: reg.body.pushId, auth: reg.body.secret, kind: 'done', sealed: 'AAA' }, deps);
  assert.equal(out.status, 200);
  const { host, headers, body } = fake.calls[0];
  assert.equal(host, 'api.sandbox.push.apple.com');
  assert.equal(headers['apns-priority'], '5');
  assert.equal(headers['apns-collapse-id'], undefined);
  assert.equal(JSON.parse(body).aps.sound, undefined);
});

test('push: the registered bundle id wins over the default topic', async () => {
  const fake = fakeApns({ status: 200 });
  const deps = testDeps({ fakeApns: fake });
  const reg = await register(deps, { bundleId: 'com.example.custom' });
  await handlePush({ pushId: reg.body.pushId, auth: reg.body.secret, kind: 'ask', sealed: 'AAA' }, deps);
  assert.equal(fake.calls[0].headers['apns-topic'], 'com.example.custom');
});

test('push: auth and push id are checked before anything else; a tampered id is 400', async () => {
  const deps = testDeps();
  const { pushId, secret } = (await register(deps)).body;
  assert.deepEqual(await handlePush({ pushId, auth: 'wrong', kind: 'ask', sealed: 'AAA' }, deps), { status: 401, body: { error: 'unauthorized' } });
  assert.deepEqual(await handlePush({ pushId, kind: 'ask', sealed: 'AAA' }, deps), { status: 401, body: { error: 'unauthorized' } });
  // flip a byte in the id and re-sign with knowledge of the key: auth passes, decryption does not
  const raw = Buffer.from(pushId, 'base64url');
  raw[13] ^= 0x01;
  const tampered = raw.toString('base64url');
  assert.deepEqual(await handlePush({ pushId: tampered, auth: deps.auth(tampered), kind: 'ask', sealed: 'AAA' }, deps),
    { status: 400, body: { error: 'bad-request' } });
  for (const bad of [
    { pushId, auth: secret, kind: 'explode', sealed: 'AAA' },
    { pushId, auth: secret, kind: 'ask', sealed: 'not base64!' },
    { pushId, auth: secret, kind: 'ask', sealed: 'A'.repeat(3001) },
    { pushId, auth: secret, kind: 'ask' },
    { auth: secret, kind: 'ask', sealed: 'AAA' },
    { pushId, auth: secret, kind: 'ask', sealed: 'AAA', collapseId: 'c'.repeat(65) },
  ]) {
    assert.deepEqual(await handlePush(bad, deps), { status: 400, body: { error: 'bad-request' } }, JSON.stringify(bad).slice(0, 40));
  }
});

test('push: APNs answers map to ok, gone, or a retryable upstream error', async () => {
  for (const [answer, expect] of [
    [{ status: 200 }, { status: 200, body: { ok: true } }],
    [{ status: 410 }, { status: 410, body: { gone: true } }],
    [{ status: 400, reason: 'BadDeviceToken' }, { status: 410, body: { gone: true } }],
    [{ status: 400, reason: 'Unregistered' }, { status: 410, body: { gone: true } }],
    [{ status: 400, reason: 'DeviceTokenNotForTopic' }, { status: 410, body: { gone: true } }],
    [{ status: 400, reason: 'PayloadTooLarge' }, { status: 502, body: { error: 'upstream', retryable: true } }],
    [{ status: 429 }, { status: 502, body: { error: 'upstream', retryable: true } }],
    [{ status: 503 }, { status: 502, body: { error: 'upstream', retryable: true } }],
    [{ status: 403 }, { status: 502, body: { error: 'upstream', retryable: true } }],
  ]) {
    const deps = testDeps({ fakeApns: fakeApns(answer) });
    const reg = await register(deps);
    const out = await handlePush({ pushId: reg.body.pushId, auth: reg.body.secret, kind: 'ask', sealed: 'AAA' }, deps);
    assert.deepEqual(out, expect, answer.reason ?? String(answer.status));
  }
  const deps = testDeps({ fakeApns: fakeApns({ hang: true }), timeoutMs: 40 });   // an APNs timeout is retryable
  const reg = await register(deps);
  assert.deepEqual(await handlePush({ pushId: reg.body.pushId, auth: reg.body.secret, kind: 'ask', sealed: 'AAA' }, deps),
    { status: 502, body: { error: 'upstream', retryable: true } });
});

test('limits: 30/min per push id with burst 10, and 20 registrations per hour per ip', async () => {
  const deps = testDeps({ fakeApns: fakeApns({ status: 200 }) });
  const reg = (await register(deps)).body;
  const req = { pushId: reg.pushId, auth: reg.secret, kind: 'ask', sealed: 'AAA' };
  for (let i = 0; i < 10; i++) assert.equal((await handlePush(req, deps)).status, 200, `burst ${i}`);
  assert.deepEqual(await handlePush(req, deps), { status: 429, body: { error: 'rate-limited' } });

  const regDeps = testDeps();
  for (let i = 0; i < 20; i++) assert.equal((await register(regDeps)).status, 200);
  assert.deepEqual(await register(regDeps), { status: 429, body: { error: 'rate-limited' } });
});

test('payload cap: the 4 KB ceiling is enforced on the built payload', () => {
  const ok = buildApnsPayload('ask', 'A'.repeat(3000));                        // the largest accepted sealed
  assert.ok(Buffer.byteLength(ok) <= 4096);
  assert.equal(buildApnsPayload('ask', 'A'.repeat(5000)), null);               // past the cap (validation keeps this unreachable via the API)
});

test('serveApi: POST only, 8 KB bodies, and exactly one log line per request with route and status', async () => {
  const lines = [];
  const deps = testDeps({ log: (line) => lines.push(line) });
  const call = async (method, body) => {
    const res = fakeRes();
    await serveApi({ req: { method, body, headers: {} }, res, route: '/api/register', method: 'POST', deps, run: (b) => handleRegister(b, deps) });
    return { status: res.code, body: res.body };
  };
  assert.deepEqual(await call('GET', undefined), { status: 405, body: { error: 'method-not-allowed' } });
  assert.deepEqual(await call('DELETE', {}), { status: 405, body: { error: 'method-not-allowed' } });
  assert.deepEqual(await call('POST', 'hello'), { status: 400, body: { error: 'bad-request' } });         // not an object
  assert.deepEqual(await call('POST', ['a']), { status: 400, body: { error: 'bad-request' } });          // not an object
  assert.deepEqual(await call('POST', { big: 'x'.repeat(9000) }), { status: 413, body: { error: 'too-large' } });
  assert.deepEqual(await call('POST', undefined), { status: 400, body: { error: 'bad-request' } });
  assert.equal((await call('POST', { deviceToken: 'a'.repeat(64), env: 'production' })).status, 200);
  assert.equal(lines.length, 7);                                                // one line per request, nothing else
  for (const line of lines) assert.match(line, /^(GET|POST|DELETE) \/api\/register \d{3}$/);
});

test('nothing sensitive is ever logged, and console stays quiet', async () => {
  const recorded = [];
  const originals = {};
  for (const name of ['log', 'warn', 'error', 'info']) {
    originals[name] = console[name];
    console[name] = (...a) => recorded.push(`${name}: ${a.join(' ')}`);
  }
  try {
    const fake = fakeApns({ status: 200 });
    const deps = testDeps({ fakeApns: fake, log: (line) => recorded.push(line) });
    const reg = (await register(deps)).body;
    await handlePush({ pushId: reg.pushId, auth: reg.secret, kind: 'ask', sealed: 'SECRETSEALED', collapseId: 'z1' }, deps);
    await handlePush({ pushId: reg.pushId, auth: 'wrong', kind: 'ask', sealed: 'SECRETSEALED' }, deps);   // a 401
    const res = fakeRes();
    await serveApi({ req: { method: 'GET', headers: {} }, res, route: '/api/register', method: 'POST', deps, run: () => handleRegister({}, deps) });
    // default deps log through console: push a request through them under a real-shaped env
    const dd = defaultDeps({ PUSH_SERVER_KEY: crypto.randomBytes(32).toString('base64'), APNS_KEY: 'k', APNS_KEY_ID: 'kid', APNS_TEAM_ID: 'team' });
    dd.apnsSend = async () => ({ ok: false, status: 500 });                     // no real network in tests
    await serveApi({
      req: { method: 'POST', body: { deviceToken: 'a'.repeat(64), env: 'production' }, headers: {} }, res: fakeRes(),
      route: '/api/register', method: 'POST', deps: dd, run: (b) => handleRegister(b, { ...dd, ip: ipOf({ headers: {} }) }),
    });
  } finally {
    for (const [name, fn] of Object.entries(originals)) console[name] = fn;
  }
  const secrets = ['a'.repeat(64), 'SECRETSEALED', 'z1'];
  for (const line of recorded) {
    for (const s of secrets) assert.ok(!line.includes(s), `a secret leaked: ${line}`);
    if (line.startsWith('POST /api/')) assert.match(line, /^POST \/api\/(register|push) \d{3}$/);
  }
});

test('defaultDeps: no server key means no service; the topic default comes from the env', () => {
  assert.equal(defaultDeps({}), null);
  assert.equal(defaultDeps({ PUSH_SERVER_KEY: 'not base64!!!' }), null);
  assert.equal(defaultDeps({ PUSH_SERVER_KEY: Buffer.from('too short').toString('base64') }), null);
  const env = { PUSH_SERVER_KEY: crypto.randomBytes(32).toString('base64') };
  const deps = defaultDeps(env);
  assert.equal(typeof deps.auth, 'function');
  assert.equal(typeof deps.log, 'function');
  assert.equal(deps.topic, 'sg.comex.zode');
  assert.equal(defaultDeps({ ...env, APNS_TOPIC: 'com.other.app' }).topic, 'com.other.app');
});
