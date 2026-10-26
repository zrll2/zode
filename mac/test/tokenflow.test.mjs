import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bucketize, summarizeFlow, readFlow } from '../lib/tokenflow.mjs';

const NOW = 1_800_000_000_000;
const min = 60_000;

test('bucketize: a turn spreads evenly over the minutes it ran; outside the hour is ignored', () => {
  const b = bucketize([{ start: NOW - 3 * min, end: NOW - 1 * min, tokens: 2000 }, { start: NOW - 90 * min, end: NOW - 80 * min, tokens: 9999 }], NOW);
  assert.equal(b.length, 60);
  assert.deepEqual(b.slice(-4), [0, 1000, 1000, 0]);
  assert.equal(b.reduce((a, x) => a + x, 0), 2000);
});

test('bucketize: a turn that began before the window only counts its share inside it', () => {
  const b = bucketize([{ start: NOW - 70 * min, end: NOW - 50 * min, tokens: 20_000 }], NOW);
  assert.equal(b.reduce((a, x) => a + x, 0), 10_000);
});

test('summarizeFlow: rate is the last three minutes per minute, averages per order, null when empty', () => {
  const f = summarizeFlow({ turns: [{ start: NOW - 3 * min, end: NOW, tokens: 9000 }], orders: [{ tokens: 400_000, ms: 10 * min }, { tokens: 200_000, ms: 20 * min }] }, NOW);
  assert.equal(f.rate, 3000);
  assert.equal(f.peak, 3000);
  assert.deepEqual([f.avgTokens, f.avgMs], [300_000, 15 * min]);
  assert.equal(summarizeFlow({}, NOW), null);
});

test('readFlow: a missing database is null, never a throw', async () => {
  assert.equal(await readFlow({ dbPath: '/nonexistent/db.sqlite', now: NOW }), null);
});
