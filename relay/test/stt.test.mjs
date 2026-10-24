// validateTranscribe and createLimiter, the pure helpers behind the relay's stt/* methods.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateTranscribe, createLimiter, MAX_AUDIO_BYTES } from '../stt.mjs';

test('validateTranscribe: a valid request decodes to the exact bytes', () => {
  const raw = Buffer.from('fake watch recording \u00e9\u4e2d', 'utf8');
  const v = validateTranscribe({ audio: raw.toString('base64'), format: 'm4a', language: 'zh', hint: { projects: ['A'], titles: ['B'] } });
  assert.equal(v.ok, true);
  assert.ok(Buffer.isBuffer(v.value.audio));
  assert.deepEqual(v.value.audio, raw);
  assert.equal(v.value.format, 'm4a');
  assert.equal(v.value.language, 'zh');
  assert.deepEqual(v.value.projects, ['A']);
  assert.deepEqual(v.value.titles, ['B']);
});

test('validateTranscribe: language and hint are optional and stay empty for the host default', () => {
  const v = validateTranscribe({ audio: Buffer.from('abc').toString('base64'), format: 'wav' });
  assert.equal(v.ok, true);
  assert.equal(v.value.language, undefined);
  assert.deepEqual(v.value.projects, []);
  assert.deepEqual(v.value.titles, []);
});

test('validateTranscribe: malformed requests are bad-params', () => {
  const good = Buffer.from('abc').toString('base64');                     // 'YWJj'
  for (const params of [
    undefined, null, 'nope', {},
    { audio: '', format: 'wav' },
    { audio: 'not base64!!', format: 'wav' },
    { audio: 'YW=j', format: 'wav' },                                     // = in the middle
    { audio: 'YWJjx', format: 'wav' },                                    // length % 4
    { audio: good, format: 'aac' },
    { audio: good, format: 7 },
    { audio: good },                                                      // format required
    { audio: good, format: 'wav', language: 'fr' },
    { audio: good, format: 'wav', language: 'EN' },                       // lowercase only
  ]) {
    const v = validateTranscribe(params);
    assert.deepEqual([v.ok, v.reason], [false, 'bad-params'], JSON.stringify(params) ?? String(params));
  }
});

test('validateTranscribe: empty audio is bad-params, over 3 MB is too-large, 3 MB exactly is fine', () => {
  assert.deepEqual(validateTranscribe({ audio: '', format: 'wav' }).reason, 'bad-params');
  const big = validateTranscribe({ audio: Buffer.alloc(MAX_AUDIO_BYTES + 1, 7).toString('base64'), format: 'wav' });
  assert.deepEqual([big.ok, big.reason], [false, 'too-large']);
  const edge = validateTranscribe({ audio: Buffer.alloc(MAX_AUDIO_BYTES, 7).toString('base64'), format: 'wav' });
  assert.equal(edge.ok, true);
});

test('validateTranscribe: hints are clamped, never refused', () => {
  const v = validateTranscribe({
    audio: Buffer.from('abc').toString('base64'), format: 'wav',
    hint: { projects: [123, '   ', 'ok', 'x'.repeat(100), ...Array.from({ length: 25 }, (_, i) => `p${i}`)], titles: 'not an array', extra: ['ignored'] },
  });
  assert.equal(v.ok, true);
  assert.deepEqual(v.value.projects, ['ok', 'x'.repeat(60), ...Array.from({ length: 18 }, (_, i) => `p${i}`)]);   // 20 entries, 60 chars max
  assert.deepEqual(v.value.titles, []);
  const v2 = validateTranscribe({ audio: Buffer.from('abc').toString('base64'), format: 'wav', hint: null });
  assert.equal(v2.ok, true);
  assert.deepEqual(v2.value.projects, []);
});

test('createLimiter: one in flight per device; release frees the slot; devices are independent', () => {
  const limiter = createLimiter();
  assert.equal(limiter.take('dev1'), true);
  assert.equal(limiter.take('dev1'), false);
  assert.equal(limiter.take('dev2'), true);
  limiter.release('dev1');
  assert.equal(limiter.take('dev1'), true);
  limiter.release('dev1');
  limiter.release('dev2');
});

test('createLimiter: release of an unknown device is harmless', () => {
  const limiter = createLimiter();
  limiter.release('ghost');
  assert.equal(limiter.take('ghost'), true);
});

test('createLimiter: at most 20 per window; the whole window slides out', () => {
  let t = 1000;
  const limiter = createLimiter({ now: () => t });
  for (let i = 0; i < 20; i++) { assert.equal(limiter.take('d'), true); limiter.release('d'); }
  assert.equal(limiter.take('d'), false);              // 20 in the window already
  t += 60_000;
  assert.equal(limiter.take('d'), true);               // every stamp is outside the window now
});

test('createLimiter: stamps expire by age, per windowMs and maxPerWindow', () => {
  let t = 0;
  const limiter = createLimiter({ now: () => t, windowMs: 10_000, maxPerWindow: 2 });
  assert.equal(limiter.take('d'), true); limiter.release('d');
  assert.equal(limiter.take('d'), true); limiter.release('d');
  assert.equal(limiter.take('d'), false);
  t = 10_001;                                          // both stamps are 10 s old
  assert.equal(limiter.take('d'), true);
});
