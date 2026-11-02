// eventInbox: parsing dropped event files and the drop-folder watcher — valid events delivered and
// deleted, stale or junk files deleted silently, a file processed at most once. Uses an injected
// fake fs and clock so file ages and folder contents are fully controlled.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEventFile, startEventInbox } from '../lib/eventInbox.mjs';

const NOW = 1_750_000_000_000;
const event = { source: 'github', type: 'ci.failed', subject: 'main #123', summary: 'tests red', link: 'https://github.com/x/y/runs/1' };

// An in-memory fs with just the surface the inbox touches.
function fakeFs(files = {}) {
  const store = new Map(Object.entries(files));
  const unlinked = [];
  const mkdirs = [];
  return {
    store, unlinked, mkdirs,
    readdirSync(dir) { return [...store.keys()].filter(k => k.startsWith(`${dir}/`)).map(k => k.slice(dir.length + 1)); },
    readFileSync(file) { const v = store.get(file); if (v === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return v.text; },
    statSync(file) { const v = store.get(file); if (v === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return { mtimeMs: v.mtime }; },
    unlinkSync(file) { unlinked.push(file); store.delete(file); },
    mkdirSync(dir, opts) { mkdirs.push({ dir, ...opts }); },
    watch() { return { close() {} }; },
  };
}

const start = ({ dir = '/d', onEvent, fsys, now = () => NOW }) => startEventInbox({ dir, onEvent, fs: fsys, now });
const file = (name, text, mtime = NOW) => ({ [`/d/${name}`]: { text, mtime } });

test('parseEventFile: the normalized event, extra fields dropped', () => {
  assert.deepEqual(parseEventFile(JSON.stringify({ ...event, extra: 'x' }), 0), event);
  assert.equal(parseEventFile(JSON.stringify({ source: 'gh', type: 't', subject: 's', summary: 'm' }), 0).link, '');
});

test('parseEventFile: junk, non-objects, bad links and stale drops are null', () => {
  for (const junk of [null, undefined, 42, 'plain', '', '[1,2]', '{ broken']) {
    assert.equal(parseEventFile(junk, 0), null, String(junk).slice(0, 20));
  }
  assert.equal(parseEventFile(JSON.stringify({ ...event, link: 'http://e.test/x' }), 0), null);
  assert.equal(parseEventFile(JSON.stringify(event), 300_001), null);          // over 300 s: stale
  assert.deepEqual(parseEventFile(JSON.stringify(event), 300_000), event);      // exactly 300 s still counts
  assert.equal(parseEventFile(JSON.stringify(event), NaN), null);
});

test('inbox: a valid file is delivered once and deleted; junk and stale are only deleted', () => {
  const fsys = fakeFs({
    ...file('a.json', JSON.stringify(event)),
    ...file('stale.json', JSON.stringify(event), NOW - 400_000),
    ...file('junk.json', '{ broken'),
    ...file('note.txt', 'not an event'),
  });
  const delivered = [];
  const inbox = start({ onEvent: e => delivered.push(e), fsys });
  try {
    assert.deepEqual(delivered, [event]);                                       // exactly one delivery
    assert.deepEqual(fsys.unlinked.sort(), ['/d/a.json', '/d/junk.json', '/d/stale.json']);
    assert.ok(fsys.store.has('/d/note.txt'));                                   // non-json drops stay
  } finally { inbox.stop(); }
});

test('inbox: the folder is created with mode 0700 and scans are capped at 50 files', () => {
  const files = {};
  for (let i = 0; i < 60; i++) Object.assign(files, file(`e${i}.json`, JSON.stringify(event)));
  const fsys = fakeFs(files);
  const delivered = [];
  const inbox = start({ onEvent: e => delivered.push(e), fsys });
  try {
    assert.equal(delivered.length, 50);
    assert.equal(fsys.unlinked.length, 50);
    assert.deepEqual(fsys.mkdirs, [{ dir: '/d', recursive: true, mode: 0o700 }]);
  } finally { inbox.stop(); }
});

test('inbox: with the real fs, new drops arriving after start are delivered and deleted exactly once', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zode-events-'));
  fs.mkdirSync(dir, { recursive: true });
  const delivered = [];
  const inbox = startEventInbox({ dir, onEvent: e => delivered.push(e), now: () => NOW });
  try {
    fs.writeFileSync(path.join(dir, 'live.json'), JSON.stringify(event));
    const until = async (fn, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise(r => setTimeout(r, 25)); } throw new Error('condition not met'); };
    await until(() => delivered.length === 1);
    await until(() => !fs.existsSync(path.join(dir, 'live.json')));
    await new Promise(r => setTimeout(r, 100));                     // a double delivery would show here
    assert.equal(delivered.length, 1);
  } finally { inbox.stop(); }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('inbox: a missing dir never throws and the file that appears later is consumed', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zode-events-'));
  const dir = path.join(root, 'missing');
  const delivered = [];
  const inbox = startEventInbox({ dir, onEvent: e => delivered.push(e), now: () => NOW });
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'late.json'), JSON.stringify(event));
    const until = async (fn, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise(r => setTimeout(r, 25)); } throw new Error('condition not met'); };
    await until(() => delivered.length === 1 || !fs.existsSync(path.join(dir, 'late.json')));
  } finally { inbox.stop(); }
  fs.rmSync(root, { recursive: true, force: true });
});
