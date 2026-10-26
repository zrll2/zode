// ids: the stateless push identity — token encrypted into a push id, tamper detection, and the
// derived per-phone secret.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createCodec, deriveAuthKey, authFor } from '../lib/ids.mjs';

const key = crypto.randomBytes(32);

test('codec: a register payload roundtrips through the push id', () => {
  const codec = createCodec(key);
  const payload = { t: 'a'.repeat(64), e: 'production', b: 'sg.comex.zode' };
  const pushId = codec.encrypt(payload);
  assert.match(pushId, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(codec.decrypt(pushId), payload);
  // push ids are random (fresh iv), and decrypting with the wrong key sees nothing
  assert.notEqual(codec.encrypt(payload), pushId);
  assert.equal(createCodec(crypto.randomBytes(32)).decrypt(pushId), null);
});

test('codec: a flipped byte is rejected, never mis-decrypted', () => {
  const codec = createCodec(key);
  const pushId = codec.encrypt({ t: 'b'.repeat(64), e: 'sandbox' });
  for (const at of [0, 12, 20, 40]) {                          // iv, ciphertext start, middle, tag
    const raw = Buffer.from(pushId, 'base64url');
    raw[at] ^= 0x40;
    assert.equal(codec.decrypt(raw.toString('base64url')), null, `byte ${at}`);
  }
  assert.equal(codec.decrypt('not-a-push-id'), null);
  assert.equal(codec.decrypt(''), null);
});

test('auth: derived from the server key, bound to the push id, stable and distinct', () => {
  const authKey = deriveAuthKey(key);
  const codec = createCodec(key);
  const a = codec.encrypt({ t: 'c'.repeat(64), e: 'production' });
  const b = codec.encrypt({ t: 'c'.repeat(64), e: 'production' });
  assert.equal(authFor(a, authKey), authFor(a, authKey));       // deterministic
  assert.notEqual(authFor(a, authKey), authFor(b, authKey));    // bound to the id
  assert.notEqual(authFor(a, authKey), authFor(a, deriveAuthKey(crypto.randomBytes(32))));
  assert.match(authFor(a, authKey), /^[A-Za-z0-9_-]{43}$/);     // HMAC-256 as base64url
  assert.deepEqual(deriveAuthKey(key), deriveAuthKey(key));     // derivation itself is stable
});
