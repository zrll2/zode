// apns: the provider token (ES256 JWT, raw r||s signature, 40 minute cache) and the push exchange
// against a fake HTTP/2 session: headers and path per env, APNs answers mapped, timeouts contained.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { signProviderToken, createTokenSource, apnsSend } from '../lib/apns.mjs';

const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const NOW = 1_750_000_000_000;

// A fake http2 session: request(headers) -> a stream that answers after `delay` (or never).
function fakeApns({ status = 200, reason = null, hang = false } = {}) {
  const calls = [];
  let closed = false;
  const connect = async ({ host }) => ({
    request(headers) {
      const req = new EventEmitter();
      req.setEncoding = () => {};
      req.end = (body) => {
        calls.push({ host, headers, body });
        if (hang) return;
        setTimeout(() => {
          req.emit('response', { ':status': status });
          req.emit('data', reason ? JSON.stringify({ reason }) : '{}');
          req.emit('end');
        }, 0);
      };
      return req;
    },
    close() { closed = true; },
    on() {},
  });
  return { connect, calls, wasClosed: () => closed };
}

test('provider token: ES256 header with kid, iss/iat claims, raw r||s signature', () => {
  const token = signProviderToken({ key: pair.privateKey, keyId: 'KID1', teamId: 'TEAM1', now: 1_000_000 });
  const [h, p, s] = token.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url').toString('utf8')), { alg: 'ES256', kid: 'KID1' });
  assert.deepEqual(JSON.parse(Buffer.from(p, 'base64url').toString('utf8')), { iss: 'TEAM1', iat: 1_000_000 });
  const data = Buffer.from(`${h}.${p}`);
  assert.equal(crypto.verify('sha256', data, { key: pair.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')), true);
  assert.equal(crypto.verify('sha256', Buffer.from(`${h}.${p}x`), { key: pair.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')), false);
});

test('token source: cached for 40 minutes, fresh iat after', () => {
  let t = NOW;
  const src = createTokenSource({ key: pair.privateKey, keyId: 'KID1', teamId: 'TEAM1', now: () => t });
  const a = src(), b = src();
  assert.equal(a, b);                                                       // inside the window: the same token
  t += 40 * 60 * 1000 + 1;
  const c = src();
  assert.notEqual(c, a);
  assert.equal(JSON.parse(Buffer.from(c.split('.')[1], 'base64url').toString('utf8')).iat, Math.floor(t / 1000));
});

test('apnsSend: path, auth, topic, priority, expiration and collapse id land in the request', async () => {
  const fake = fakeApns();
  const out = await apnsSend({
    connect: fake.connect, token: 'jwt.test', host: 'api.push.apple.com',
    deviceToken: 'A'.repeat(64), bundleId: 'sg.comex.zode', body: '{"aps":{}}',
    collapseId: 'conv-1', priority: 10, timeoutMs: 500,
  });
  assert.deepEqual(out, { ok: true, status: 200, reason: null });
  assert.equal(fake.calls.length, 1);
  const { host, headers, body } = fake.calls[0];
  assert.equal(host, 'api.push.apple.com');
  assert.equal(headers[':method'], 'POST');
  assert.equal(headers[':path'], `/3/device/${'A'.repeat(64)}`);
  assert.equal(headers.authorization, 'bearer jwt.test');
  assert.equal(headers['apns-topic'], 'sg.comex.zode');
  assert.equal(headers['apns-push-type'], 'alert');
  assert.equal(headers['apns-priority'], '10');
  assert.equal(headers['apns-collapse-id'], 'conv-1');
  assert.ok(Number(headers['apns-expiration']) > Date.now() / 1000 + 3000);   // about an hour out
  assert.equal(body, '{"aps":{}}');
  assert.equal(fake.wasClosed(), true);                                       // the session is always torn down
});

test('apnsSend: sandbox host on request; a 410 and the gone-reasons come back as such', async () => {
  for (const [answer, expect] of [
    [{ status: 410 }, { ok: false, status: 410, reason: null }],
    [{ status: 400, reason: 'BadDeviceToken' }, { ok: false, status: 400, reason: 'BadDeviceToken' }],
    [{ status: 400, reason: 'Unregistered' }, { ok: false, status: 400, reason: 'Unregistered' }],
    [{ status: 400, reason: 'DeviceTokenNotForTopic' }, { ok: false, status: 400, reason: 'DeviceTokenNotForTopic' }],
  ]) {
    const fake = fakeApns(answer);
    const out = await apnsSend({
      connect: fake.connect, token: 'jwt', host: 'api.sandbox.push.apple.com',
      deviceToken: 'b'.repeat(64), bundleId: 't', body: '{}', priority: 10, timeoutMs: 500,
    });
    assert.deepEqual(out, expect, answer.reason ?? String(answer.status));
  }
});

test('apnsSend: errors and timeouts never throw', async () => {
  const hang = fakeApns({ hang: true });
  const out = await apnsSend({
    connect: hang.connect, token: 'jwt', host: 'api.push.apple.com',
    deviceToken: 'c'.repeat(64), bundleId: 't', body: '{}', priority: 10, timeoutMs: 40,
  });
  assert.deepEqual(out, { ok: false, timeout: true });
  assert.equal(hang.wasClosed(), true);                                       // torn down at the deadline

  const breaking = { connect: async () => { throw new Error('boom'); } };
  assert.deepEqual(await apnsSend({ connect: breaking.connect, token: 'j', host: 'h', deviceToken: 'd', bundleId: 't', body: '{}', timeoutMs: 100 }),
    { ok: false, error: 'connect' });
  const junkSession = { connect: async () => ({}) };                          // a session without request()
  assert.deepEqual(await apnsSend({ connect: junkSession.connect, token: 'j', host: 'h', deviceToken: 'd', bundleId: 't', body: '{}', timeoutMs: 100 }),
    { ok: false, error: 'connect' });
});
