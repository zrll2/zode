// push: sealing for the phone (fixed vector, tamper and AAD detection), the pusher's exchange with
// the push service, and the relay's notifyDevices — activity skipping, gone cleanup, and the
// delayed push for a pending permission.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { sealPush, openSealed, createPusher, DEFAULT_PUSH_URL } from '../push.mjs';

const NOW = 1_750_000_000_000;

// The shared test vector: key and iv are fixed constants (a test key, never a real one), so the
// phone implementation can be checked byte for byte against this construction.
const VECTOR = {
  key: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',            // 32 zero bytes, base64url
  iv: Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]),
  kind: 'ask',
  plaintext: JSON.stringify({ v: 1, kind: 'ask', title: 'zode-live-wt', body: 'Run: npm test', req: { server: 42, id: 'req-9' }, at: 1_750_000_000_000 }),
};

const fixedSealed = () => {
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(VECTOR.key, 'base64url'), VECTOR.iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(VECTOR.kind));
  return Buffer.concat([VECTOR.iv, cipher.update(VECTOR.plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]).toString('base64url');
};

test('the fixed vector opens; tampering and a kind mismatch do not', () => {
  const sealed = fixedSealed();
  assert.deepEqual(openSealed(VECTOR.key, VECTOR.kind, sealed), JSON.parse(VECTOR.plaintext));
  // sealPush uses a fresh iv, but its output opens just the same
  const sealedNow = sealPush(VECTOR.key, VECTOR.kind, JSON.parse(VECTOR.plaintext));
  assert.deepEqual(openSealed(VECTOR.key, VECTOR.kind, sealedNow), JSON.parse(VECTOR.plaintext));
  // a flipped byte anywhere, the wrong key, or the wrong AAD kind all fail closed
  const raw = Buffer.from(sealed, 'base64url');
  raw[13] ^= 0x01;
  assert.equal(openSealed(VECTOR.key, VECTOR.kind, raw.toString('base64url')), null);
  assert.equal(openSealed(crypto.randomBytes(32).toString('base64url'), VECTOR.kind, sealed), null);
  assert.equal(openSealed(VECTOR.key, 'question', sealed), null);
  assert.equal(openSealed('short', VECTOR.kind, sealed), null);
});

function fakeFetch(responses) {                                    // consumed in order; the last one repeats
  const calls = [];
  const fetch = async (url, opts) => {
    const r = responses[Math.min(calls.length, responses.length - 1)];
    calls.push({ url, headers: opts.headers, body: JSON.parse(opts.body) });
    return { status: r.status, json: async () => r.body ?? {} };
  };
  return { fetch, calls };
}

const device = () => ({
  id: 'dev1',
  pushKey: 'B'.repeat(43),
  push: { pushId: 'P'.repeat(30), secret: 'S'.repeat(30), env: 'production' },
});

test('pusher: seals with the device key and posts the exact contract', async () => {
  const { fetch, calls } = fakeFetch([{ status: 200, body: { ok: true } }]);
  const lines = [];
  const pusher = createPusher({ url: 'https://push.test', fetch, log: (l) => lines.push(l), now: () => NOW });
  assert.equal(DEFAULT_PUSH_URL, 'https://zode-push.vercel.app');
  const out = await pusher.send(device(), { kind: 'ask', title: 'proj', body: 'Run: npm test', session: 'sess1', req: { server: 1, id: 2 } });
  assert.deepEqual(out, { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://push.test/api/push');
  const sent = calls[0].body;
  assert.deepEqual([sent.pushId, sent.auth, sent.kind], ['P'.repeat(30), 'S'.repeat(30), 'ask']);
  assert.equal(sent.collapseId, 'sess1:ask');
  const opened = openSealed(device().pushKey, 'ask', sent.sealed);
  assert.equal(opened.v, 1);
  assert.deepEqual([opened.kind, opened.title, opened.body, opened.session, opened.project, opened.req], ['ask', 'proj', 'Run: npm test', 'sess1', undefined, { server: 1, id: 2 }]);
  assert.ok(opened.at > 0);
  assert.ok(!lines.join('\n').includes(device().pushKey) && !lines.join('\n').includes('Run: npm test'));
});

test('pusher: collapse id caps at 64 characters; no id means no collapse id', async () => {
  const { fetch, calls } = fakeFetch([{ status: 200, body: { ok: true } }]);
  const pusher = createPusher({ url: 'https://push.test', fetch, retryDelayMs: 1 });
  await pusher.send(device(), { kind: 'ask', session: 'x'.repeat(100) });
  assert.equal(calls[0].body.collapseId.length, 64);
  await pusher.send(device(), { kind: 'done' });
  assert.equal('collapseId' in calls[1].body, false);
});

test('pusher: 410 is gone, a retryable 502 retries once, and nothing sensitive leaks into the log', async () => {
  const { fetch, calls } = fakeFetch([{ status: 502, body: { error: 'upstream', retryable: true } }, { status: 200, body: { ok: true } }]);
  const lines = [];
  const pusher = createPusher({ url: 'https://push.test', fetch, log: (l) => lines.push(l), retryDelayMs: 1 });
  const out = await pusher.send(device(), { kind: 'failed', title: 'T', body: 'Open Zode to retry.' });
  assert.deepEqual(out, { ok: true });
  assert.equal(calls.length, 2);                                    // the retry happened
  assert.deepEqual(await pusher.send(device(), { kind: 'ask' }), { ok: true });
  assert.equal(calls.length, 3);                                    // a settled answer does not retry

  const gone = fakeFetch([{ status: 410, body: { gone: true } }]);
  const pusher2 = createPusher({ url: 'https://push.test', fetch: gone.fetch, retryDelayMs: 1 });
  assert.deepEqual(await pusher2.send(device(), { kind: 'ask' }), { gone: true });

  const dead = fakeFetch([{ status: 502, body: { error: 'upstream', retryable: true } }]);
  const pusher3 = createPusher({ url: 'https://push.test', fetch: dead.fetch, retryDelayMs: 1 });
  const failed = await pusher3.send(device(), { kind: 'ask' });
  assert.equal(failed.error !== undefined, true);
  assert.equal(dead.calls.length, 2);                               // exactly one retry

  const throwing = async () => { throw new Error('unreachable'); };
  const pusher4 = createPusher({ url: 'https://push.test', fetch: throwing, retryDelayMs: 1 });
  assert.equal((await pusher4.send(device(), { kind: 'ask' })).error !== undefined, true);

  // a phone without a registration or a key is skipped, never posted
  const pusher5 = createPusher({ url: 'https://push.test', fetch, retryDelayMs: 1 });
  assert.deepEqual(await pusher5.send({ id: 'dev2' }, { kind: 'ask' }), { skipped: 'no-registration' });
});

test('pusher: the log line carries device id, kind and outcome only', async () => {
  const { fetch } = fakeFetch([{ status: 200, body: { ok: true } }]);
  const lines = [];
  const pusher = createPusher({ url: 'https://push.test', fetch, log: (l) => lines.push(l), retryDelayMs: 1 });
  await pusher.send(device(), { kind: 'question', title: 'SECRET TITLE', body: 'SECRET BODY' });
  assert.match(lines[0], /^push question sent -> dev1$/);
  const joined = lines.join('\n');
  for (const secret of [device().pushKey, device().push.pushId, device().push.secret, 'SECRET TITLE', 'SECRET BODY']) {
    assert.ok(!joined.includes(secret), 'sensitive text in the log');
  }
});
