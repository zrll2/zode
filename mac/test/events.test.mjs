// events: the Claude Code feed file — line format, privacy, mode 0600, rotation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eventLine, createEventFeed } from '../lib/events.mjs';

const NOW = 1_750_000_000_000;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zode-events-'));

test('eventLine: the exact shape, nothing else; title clamped and flattened', () => {
  const line = eventLine({ kind: 'finished', sessionId: 'sess_1', project: 'web', title: 'Ship it\nnow', workspace: '/w' }, NOW);
  const parsed = JSON.parse(line);
  assert.deepEqual(Object.keys(parsed), ['v', 'at', 'kind', 'sessionId', 'project', 'title', 'workspace']);
  assert.deepEqual(parsed, { v: 1, at: NOW, kind: 'finished', sessionId: 'sess_1', project: 'web', title: 'Ship it now', workspace: '/w' });
  const long = eventLine({ kind: 'failed', sessionId: 's', title: 'x'.repeat(300) }, NOW);
  assert.equal(JSON.parse(long).title.length, 120);
});

test('eventLine: junk events are skipped, never written', () => {
  for (const junk of [null, undefined, 42, 'x', {}, { kind: 'explode', sessionId: 's' }, { kind: 'finished' }, { kind: 'finished', sessionId: 42 }]) {
    assert.equal(eventLine(junk, NOW), null, JSON.stringify(junk));
  }
});

test('feed: appends in order, mode 0600, junk lines never touch the file', async () => {
  const dir = tmp();
  const feed = createEventFeed({ dir, now: () => NOW });
  assert.equal(await feed.append({ kind: 'finished', sessionId: 's1', project: 'p', title: 'T' }), true);
  assert.equal(await feed.append({ kind: 'failed', sessionId: 's2', project: 'p', title: 'U' }), true);
  assert.equal(await feed.append({ kind: 'exploded', sessionId: 's3' }), false);      // junk: skipped
  const file = path.join(dir, 'events.jsonl');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).sessionId, 's1');
  assert.equal(JSON.parse(lines[1]).sessionId, 's2');
  // fire-and-forget bursts still land in order
  await Promise.all(Array.from({ length: 10 }, (_, i) => feed.append({ kind: 'needs', sessionId: 'b' + i })));
  const all = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
  assert.equal(all.length, 12);
  assert.deepEqual(all.slice(2).map(l => JSON.parse(l).sessionId), Array.from({ length: 10 }, (_, i) => 'b' + i));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('feed: rotation replaces events.jsonl with events.jsonl.1 when the file grows past the cap', async () => {
  const dir = tmp();
  const feed = createEventFeed({ dir, now: () => NOW, maxBytes: 100 });
  await feed.append({ kind: 'finished', sessionId: 's1', project: 'p', title: 'first' });
  await feed.append({ kind: 'failed', sessionId: 's2', project: 'p', title: 'second' });   // pushes the file past 100: rotates first
  const first = fs.readFileSync(path.join(dir, 'events.jsonl.1'), 'utf8');
  assert.match(first, /"sessionId":"s1"/);
  const fresh = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8');
  assert.match(fresh, /"sessionId":"s2"/);
  assert.ok(!fresh.includes('s1'));                                                  // a fresh file after the rotation
  // and it keeps going after the rotation
  await feed.append({ kind: 'stuck', sessionId: 's3', project: 'p', title: 'third' });
  assert.match(fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8'), /"sessionId":"s3"/);
  fs.rmSync(dir, { recursive: true, force: true });
});
