// modelStatus states and downloadModel against a fake fetch: resume, the checks, and the cleanup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { MODELS, modelPath, modelStatus, downloadModel } from '../lib/models.mjs';

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const DIR = '/models';
const FINAL = modelPath('small', DIR);
const PART = `${FINAL}.part`;

// Point MODELS.small at tiny test content; returns the restore function.
function patchSmall(content) {
  const orig = { ...MODELS.small };
  MODELS.small.bytes = content.length;
  MODELS.small.sha256 = sha256(content);
  return () => Object.assign(MODELS.small, orig);
}

// A tiny in-memory fs with just the promises API models.mjs touches.
function fakeFs(initial = {}) {
  const files = new Map(Object.entries(initial).map(([p, v]) => [p, Buffer.from(v)]));
  const events = { unlinked: [] };
  const boom = (p) => Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
  const promises = {
    async mkdir() {},
    async stat(p) { const b = files.get(String(p)); if (!b) throw boom(p); return { size: b.length }; },
    async readFile(p) { const b = files.get(String(p)); if (!b) throw boom(p); return Buffer.from(b); },
    async writeFile(p, data) { files.set(String(p), Buffer.from(data)); },
    async unlink(p) { if (!files.has(String(p))) throw boom(p); files.delete(String(p)); events.unlinked.push(String(p)); },
    async rename(a, b) { const v = files.get(String(a)); if (!v) throw boom(a); files.delete(String(a)); files.set(String(b), v); },
    async open(p, flag) {
      const key = String(p);
      if (flag === 'r' && !files.has(key)) throw boom(key);
      if (flag === 'w') files.set(key, Buffer.alloc(0));
      let pos = flag === 'a' ? (files.get(key)?.length ?? 0) : 0;
      return {
        async write(buf) {
          files.set(key, Buffer.concat([files.get(key) ?? Buffer.alloc(0), Buffer.from(buf)]));
          return { bytesWritten: buf.length };
        },
        async read(buf, off, len, position) {
          const cur = files.get(key) ?? Buffer.alloc(0);
          const at = position ?? pos;
          const slice = cur.subarray(at, at + len);
          slice.copy(buf, off);
          pos = at + slice.length;
          return { bytesRead: slice.length, buffer: buf };
        },
        async close() {},
      };
    },
  };
  return { promises, files, events };
}

// Serves one buffer in small chunks; with a Range header it answers 206 from that offset (unless
// ignoreRange, which stands in for a server that cannot resume) and records every call.
function fakeFetch(full, { chunkSize = 5, ignoreRange = false } = {}) {
  const calls = [];
  const fetch = async (url, opts = {}) => {
    const range = opts.headers?.Range ?? null;
    let skip = 0, status = 200;
    if (range && !ignoreRange) { skip = Number(/^bytes=(\d+)-/.exec(range)[1]); status = 206; }
    calls.push({ url, range, status });
    const body = (async function* () {
      for (let i = skip; i < full.length; i += chunkSize) yield full.subarray(i, Math.min(i + chunkSize, full.length));
    })();
    return { ok: true, status, headers: { get: (h) => (String(h).toLowerCase() === 'content-length' ? String(full.length - skip) : null) }, body };
  };
  fetch.calls = calls;
  return fetch;
}

test('modelStatus: missing, partial, ready', async () => {
  const content = Buffer.from('abcdef');
  const restore = patchSmall(content);
  try {
    assert.deepEqual(await modelStatus('small', { dir: DIR, fs: fakeFs() }), { state: 'missing', bytes: 0 });
    assert.deepEqual(await modelStatus('small', { dir: DIR, fs: fakeFs({ [FINAL]: 'abc' }) }), { state: 'partial', bytes: 3 });
    assert.deepEqual(await modelStatus('small', { dir: DIR, fs: fakeFs({ [FINAL]: content }) }), { state: 'ready', bytes: 6 });
  } finally { restore(); }
});

test('modelStatus: base.en has no known size, so any present file is ready', async () => {
  const base = modelPath('base.en', DIR);
  assert.deepEqual(await modelStatus('base.en', { dir: DIR, fs: fakeFs() }), { state: 'missing', bytes: 0 });
  assert.deepEqual(await modelStatus('base.en', { dir: DIR, fs: fakeFs({ [base]: 'whatever bytes' }) }), { state: 'ready', bytes: 14 });
});

test('downloadModel: fresh download passes the checks and renames the part away', async () => {
  const content = Buffer.from('hello whisper model');
  const restore = patchSmall(content);
  try {
    const fsx = fakeFs();
    const fetch = fakeFetch(content);
    const seen = [];
    const res = await downloadModel('small', { dir: DIR, fetch, fs: fsx, onProgress: (p) => seen.push(p) });
    assert.equal(res.ok, true);
    assert.equal(fsx.files.get(FINAL).toString(), 'hello whisper model');
    assert.ok(![...fsx.files.keys()].some((k) => k.endsWith('.part')));
    assert.equal(fetch.calls.length, 1);
    assert.equal(fetch.calls[0].url, 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin');
    assert.equal(fetch.calls[0].range, null);
    assert.deepEqual(seen[seen.length - 1], { received: content.length, total: content.length });
  } finally { restore(); }
});

test('downloadModel: resumes a partial .part with a Range request', async () => {
  const content = Buffer.from('0123456789');
  const restore = patchSmall(content);
  try {
    const fsx = fakeFs({ [PART]: '0123' });
    const fetch = fakeFetch(content);
    const seen = [];
    const res = await downloadModel('small', { dir: DIR, fetch, fs: fsx, onProgress: (p) => seen.push(p) });
    assert.equal(res.ok, true);
    assert.equal(fetch.calls[0].range, 'bytes=4-');
    assert.equal(fetch.calls[0].status, 206);
    assert.equal(fsx.files.get(FINAL).toString(), '0123456789');
    assert.ok(!fsx.files.has(PART));
    assert.deepEqual(seen[seen.length - 1], { received: 10, total: 10 });
  } finally { restore(); }
});

test('downloadModel: a full-sized .part is verified without touching the network', async () => {
  const content = Buffer.from('0123456789');
  const restore = patchSmall(content);
  try {
    const fetch = fakeFetch(content);
    const res = await downloadModel('small', { dir: DIR, fetch, fs: fakeFs({ [PART]: content }) });
    assert.equal(res.ok, true);
    assert.equal(fetch.calls.length, 0);
  } finally { restore(); }
});

test('downloadModel: an already-complete model is skipped', async () => {
  const content = Buffer.from('0123456789');
  const restore = patchSmall(content);
  try {
    const fetch = fakeFetch(content);
    const res = await downloadModel('small', { dir: DIR, fetch, fs: fakeFs({ [FINAL]: content }) });
    assert.deepEqual(res, { ok: true, skipped: true, file: FINAL, bytes: content.length });
    assert.equal(fetch.calls.length, 0);
  } finally { restore(); }
});

test('downloadModel: checksum failure deletes the .part and fails', async () => {
  const content = Buffer.from('0123456789');
  const restore = patchSmall(content);
  MODELS.small.sha256 = '0'.repeat(64);
  try {
    const fsx = fakeFs();
    const res = await downloadModel('small', { dir: DIR, fetch: fakeFetch(content), fs: fsx });
    assert.equal(res.ok, false);
    assert.match(res.error, /checksum/);
    assert.ok(!fsx.files.has(PART));
    assert.ok(!fsx.files.has(FINAL));
  } finally { restore(); }
});

test('downloadModel: size mismatch deletes the .part and fails', async () => {
  const content = Buffer.from('0123456789');
  const restore = patchSmall(content);
  MODELS.small.bytes = 999;
  try {
    const fsx = fakeFs();
    const res = await downloadModel('small', { dir: DIR, fetch: fakeFetch(content), fs: fsx });
    assert.equal(res.ok, false);
    assert.match(res.error, /size mismatch/);
    assert.ok(!fsx.files.has(PART));
    assert.ok(!fsx.files.has(FINAL));
  } finally { restore(); }
});

test('downloadModel: a server that ignores the Range restarts from zero', async () => {
  const content = Buffer.from('0123456789');
  const restore = patchSmall(content);
  try {
    const fsx = fakeFs({ [PART]: '0123' });
    const fetch = fakeFetch(content, { ignoreRange: true });
    const res = await downloadModel('small', { dir: DIR, fetch, fs: fsx });
    assert.equal(res.ok, true);
    assert.equal(fetch.calls[0].range, 'bytes=4-');
    assert.equal(fetch.calls[0].status, 200);
    assert.equal(fsx.files.get(FINAL).toString(), '0123456789');
  } finally { restore(); }
});

test('downloadModel: an aborted download keeps the .part for the next try', async () => {
  const restore = patchSmall(Buffer.from('0123456789'));
  try {
    const fsx = fakeFs({ [PART]: '0123' });
    const fetch = async () => { const err = new Error('The operation was aborted'); err.name = 'AbortError'; throw err; };
    const res = await downloadModel('small', { dir: DIR, fetch, fs: fsx });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'aborted');
    assert.equal(fsx.files.get(PART).toString(), '0123');
  } finally { restore(); }
});
