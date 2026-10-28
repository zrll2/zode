// bannerInbox: parsing dropped banner files and the drop-folder watcher — valid files delivered
// and deleted, stale or junk files deleted, a file processed at most once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseBanner, startBannerInbox } from '../lib/bannerInbox.mjs';

const NOW = 1_750_000_000_000;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zode-banners-'));
const until = async (fn, ms = 2000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise(r => setTimeout(r, 25)); } throw new Error('condition not met in time'); };

test('parseBanner: the exact shape, sound only when true', () => {
  assert.deepEqual(parseBanner(JSON.stringify({ title: '  Build done  ', body: ' 2 failing ', sound: true }), 0),
    { title: 'Build done', body: '2 failing', sound: true });
  assert.deepEqual(parseBanner(JSON.stringify({ title: 'T', body: 'B', sound: 'yes' }), 0), { title: 'T', body: 'B', sound: false });
  assert.deepEqual(parseBanner(JSON.stringify({ title: 'T' }), 0), { title: 'T', body: '', sound: false });
  assert.deepEqual(parseBanner(JSON.stringify({ body: 'only a body' }), 0), { title: '', body: 'only a body', sound: false });
});

test('parseBanner: strings are trimmed and capped at 80/200', () => {
  const wide = parseBanner(JSON.stringify({ title: 't'.repeat(120), body: 'b'.repeat(300) }), 0);
  assert.equal(wide.title.length, 80);
  assert.equal(wide.body.length, 200);
});

test('parseBanner: both fields empty, stale, junk and non-objects are null', () => {
  assert.equal(parseBanner(JSON.stringify({ title: '   ' }), 0), null);
  assert.equal(parseBanner(JSON.stringify({}), 0), null);
  assert.equal(parseBanner(JSON.stringify({ title: 'T' }), 120_001), null);       // over 120 s: stale
  assert.deepEqual(parseBanner(JSON.stringify({ title: 'T' }), 120_000), { title: 'T', body: '', sound: false });   // exactly 120 s still counts
  for (const junk of [null, undefined, 42, 'plain text', '', '[1,2]', '{ broken', '{ title: unquoted }']) {
    assert.equal(parseBanner(junk, 0), null, String(junk).slice(0, 30));
  }
});

test('inbox: an existing valid file is delivered once and deleted; junk and stale files are only deleted', async () => {
  const dir = tmp();
  const delivered = [];
  fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ title: 'Build done', body: '2 failing', sound: true }));
  fs.writeFileSync(path.join(dir, 'stale.json'), JSON.stringify({ title: 'too old' }));
  fs.utimesSync(path.join(dir, 'stale.json'), new Date(NOW - 200_000), new Date(NOW - 200_000));
  fs.writeFileSync(path.join(dir, 'junk.json'), '{ broken');
  fs.writeFileSync(path.join(dir, 'note.txt'), 'not a banner');

  const inbox = startBannerInbox({ dir, onBanner: (b) => delivered.push(b), now: () => NOW });
  try {
    assert.deepEqual(delivered, [{ title: 'Build done', body: '2 failing', sound: true }]);
    assert.deepEqual(fs.readdirSync(dir).filter(n => n.endsWith('.json')), []);    // every drop is consumed
    assert.equal(fs.existsSync(path.join(dir, 'note.txt')), true);                 // non-json drops stay
  } finally { inbox.stop(); }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('inbox: new drops arriving after start are delivered and deleted exactly once', async () => {
  const dir = tmp();
  const delivered = [];
  const inbox = startBannerInbox({ dir, onBanner: (b) => delivered.push(b), now: () => NOW });
  try {
    fs.writeFileSync(path.join(dir, 'live.json'), JSON.stringify({ title: 'Live one' }));
    await until(() => delivered.length === 1);
    assert.deepEqual(delivered[0], { title: 'Live one', body: '', sound: false });
    await until(() => !fs.existsSync(path.join(dir, 'live.json')));
    await new Promise(r => setTimeout(r, 100));                       // a double delivery would show here
    assert.equal(delivered.length, 1);
  } finally { inbox.stop(); }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('inbox: a vanished file and a missing dir never throw', async () => {
  const dir = tmp();
  const delivered = [];
  const inbox = startBannerInbox({ dir: path.join(dir, 'missing'), onBanner: (b) => delivered.push(b) });
  try {
    fs.writeFileSync(path.join(dir, 'missing', 'race.json'), JSON.stringify({ title: 'X' }));
    await until(() => delivered.length === 1 || !fs.existsSync(path.join(dir, 'missing', 'race.json')));
  } finally { inbox.stop(); }
  fs.rmSync(dir, { recursive: true, force: true });
});
