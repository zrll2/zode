// zode-watch: the plain-line formatter and the tailing watcher — no history, appends printed,
// rotation followed, everything within a couple of seconds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { formatEvent, createWatcher } from '../bin/zode-watch.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zode-watch-'));
const until = async (fn, ms = 2000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise(r => setTimeout(r, 25)); } throw new Error('condition not met in time'); };

test('formatEvent: the four kinds, the workspace bracket, junk and unknown kinds print nothing', () => {
  assert.equal(formatEvent({ kind: 'finished', project: 'web', title: 'Ship it', sessionId: 's1', workspace: '/w' }),
    'finished: web - Ship it (session s1) [/w]');
  assert.equal(formatEvent({ kind: 'failed', project: 'web', title: 'Boom', sessionId: 's2' }),
    'failed: web - Boom (session s2)');
  assert.equal(formatEvent({ kind: 'needs', sessionId: 's3', title: '' }),
    'needs you: Zode - ZCode (session s3)');                        // no title: the project stands in
  assert.equal(formatEvent({ kind: 'stuck', project: 'web', sessionId: 's4', title: 'Multi\nline' }),
    'stuck: web - Multi line (session s4)');
  for (const junk of [null, 42, 'x', {}, { kind: 'exploded', sessionId: 's' }, { sessionId: 's' }]) {
    assert.equal(formatEvent(junk), null);
  }
});

test('watcher: starts at the end (no history), prints appends promptly, follows rotation', async () => {
  const dir = tmp();
  const file = path.join(dir, 'events.jsonl');
  fs.writeFileSync(file, [
    JSON.stringify({ kind: 'finished', project: 'old', title: 'before the watcher', sessionId: 'h1' }),
    JSON.stringify({ kind: 'failed', project: 'old', title: 'also before', sessionId: 'h2' }),
  ].join('\n') + '\n');

  const seen = [];
  const stop = createWatcher(file, { onLine: (raw) => seen.push(JSON.parse(raw).title), pollMs: 50 });
  try {
    // no history: the two pre-existing lines never print
    await new Promise(r => setTimeout(r, 300));
    assert.deepEqual(seen, []);
    // an append prints within the poll window
    fs.appendFileSync(file, JSON.stringify({ kind: 'finished', project: 'web', title: 'first live', sessionId: 'l1' }) + '\n');
    await until(() => seen.includes('first live'));
    // rotation: the file is replaced and the new one is followed from its start
    fs.renameSync(file, path.join(dir, 'events.jsonl.1'));
    fs.writeFileSync(file, JSON.stringify({ kind: 'needs', project: 'web', title: 'after rotation', sessionId: 'l2' }) + '\n');
    fs.appendFileSync(file, JSON.stringify({ kind: 'stuck', project: 'web', title: 'after rotation 2', sessionId: 'l3' }) + '\n');
    await until(() => seen.includes('after rotation'));
    await until(() => seen.includes('after rotation 2'));
    assert.deepEqual(seen, ['first live', 'after rotation', 'after rotation 2']);
  } finally {
    stop();
    // stopped: nothing more is printed
    const n = seen.length;
    fs.appendFileSync(path.join(dir, 'events.jsonl'), JSON.stringify({ kind: 'finished', project: 'x', title: 'too late', sessionId: 'l4' }) + '\n');
    await new Promise(r => setTimeout(r, 200));
    assert.equal(seen.length, n);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('watcher: a missing file is tolerated until it appears', async () => {
  const dir = tmp();
  const file = path.join(dir, 'events.jsonl');                        // does not exist yet
  const seen = [];
  const stop = createWatcher(file, { onLine: (raw) => seen.push(raw), pollMs: 50 });
  try {
    fs.writeFileSync(file, JSON.stringify({ kind: 'failed', sessionId: 'x' }) + '\n');
    await until(() => seen.length === 1);
  } finally {
    stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
