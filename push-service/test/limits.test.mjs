// limits: the token bucket arithmetic (burst, refill, per-key independence) and the hard cap on the
// number of live keys: at MAX_KEYS the oldest entries are evicted so the map can never grow without bound.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBucket } from '../lib/limits.mjs';

const NOW = Date.parse('2026-10-25T12:00:00Z');

test('buckets: burst then refill over time; keys are independent', () => {
  const b = createBucket({ capacity: 2, perMs: 1 / 1000 });                  // one token per second
  assert.equal(b.take('k', NOW), true);
  assert.equal(b.take('k', NOW), true);
  assert.equal(b.take('k', NOW), false);                                     // burst spent
  assert.equal(b.take('k', NOW + 500), false);                               // half a token back: still dry
  assert.equal(b.take('k', NOW + 1000), true);                               // a full second: one token back
  assert.equal(b.take('other', NOW), true);                                  // another key is unaffected
});

test('buckets: at max size the oldest keys are evicted, so the map stops growing and a cold key resets', () => {
  const b = createBucket({ capacity: 2, perMs: 0 });                         // no refill: spent stays spent
  assert.equal(b.take('first', NOW), true);
  assert.equal(b.take('first', NOW), true);
  assert.equal(b.take('first', NOW), false);                                 // 'first' is exhausted
  for (let i = 0; i < 10_000; i++) assert.equal(b.take(`k${i}`, NOW), true); // fill the map to its cap
  assert.equal(b.take('new', NOW), true);                                    // room is made for new keys...
  assert.equal(b.take('first', NOW), true);                                  // ...by evicting 'first', the oldest: fresh again
});
