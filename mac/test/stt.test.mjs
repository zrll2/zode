// createStt against a fake spawn and fs: the success path and its arguments, the cleanup, and
// every error code.
import { test } from 'node:test';
import realFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createStt, silenceWav } from '../lib/stt.mjs';
import { MODELS, modelPath } from '../lib/models.mjs';

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const BINARY = '/vendor/whisper-cli';
const AFCONVERT = '/usr/bin/afconvert';
const MODEL_DIR = '/models';
const MODEL_FILE = modelPath('small', MODEL_DIR);
const MODEL_CONTENT = Buffer.from('fake-model-bytes');
const WAV_1S = silenceWav(16000, 1);
const WAV_61S = silenceWav(16000, 61);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('waitFor: condition never became true');
    await sleep(5);
  }
}

// Point MODELS.small at the fake model file so modelStatus says ready; returns the restore fn.
function patchModel() {
  const orig = { ...MODELS.small };
  MODELS.small.bytes = MODEL_CONTENT.length;
  MODELS.small.sha256 = sha256(MODEL_CONTENT);
  return () => Object.assign(MODELS.small, orig);
}

// In-memory fs with the promises API stt.mjs touches, plus a record of every unlink.
function fakeFs(initial = {}) {
  const files = new Map(Object.entries(initial).map(([p, v]) => [p, Buffer.from(v)]));
  const events = { unlinked: [] };
  const boom = (p) => Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
  return {
    files,
    events,
    promises: {
      async mkdir() {},
      async stat(p) { const b = files.get(String(p)); if (!b) throw boom(p); return { size: b.length }; },
      async readFile(p) { const b = files.get(String(p)); if (!b) throw boom(p); return Buffer.from(b); },
      async writeFile(p, data) { files.set(String(p), Buffer.from(data)); },
      async unlink(p) { if (!files.has(String(p))) throw boom(p); files.delete(String(p)); events.unlinked.push(String(p)); },
    },
  };
}

// A fake spawn: the handler answers each (cmd, args) — write the converted WAV, print a transcript,
// hold the child, fail it. Handler gets the fake fs as its last argument.
function fakeSpawn(handler) {
  const calls = [];
  const children = [];
  const spawn = (cmd, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {};
    child.stderr = new EventEmitter(); child.stderr.setEncoding = () => {};
    child.kills = [];
    child.kill = (sig) => { child.kills.push(sig); setImmediate(() => child.emit('close', null, sig)); return true; };
    calls.push({ cmd, args });
    children.push(child);
    handler?.(child, cmd, args);
    return child;
  };
  return { spawn, calls, children };
}

const ok = (child, stdout = '') => setImmediate(() => { if (stdout) child.stdout.emit('data', stdout); child.emit('close', 0); });
const fail = (child, code = 1, stderr = '') => setImmediate(() => { if (stderr) child.stderr.emit('data', stderr); child.emit('close', code); });

// Everything the engine writes under tmpDir should be gone once a request settles.
const leftovers = (fsx) => [...fsx.files.keys()].filter((k) => k.includes('zode-stt-') || k.includes('zode-warm-'));

function setup({ files = {}, noModel = false, noEngine = false, handler } = {}) {
  const initial = noModel ? {} : { [MODEL_FILE]: MODEL_CONTENT };
  if (!noEngine) initial[BINARY] = '#!/bin/fake';
  const fsx = fakeFs(initial);
  const api = fakeSpawn((child, cmd, args) => handler?.(child, cmd, args, fsx));
  let tick = 1000;
  const logs = [];
  const stt = createStt({
    binary: noEngine ? null : BINARY,
    modelDir: MODEL_DIR, tmpDir: '/tmp/stt', afconvert: AFCONVERT,
    spawn: api.spawn, fs: fsx, log: (m) => logs.push(String(m)), now: () => (tick += 13),
  });
  return { stt, fsx, ...api, logs };
}

test('success: 16 kHz mono WAV runs whisper directly with the documented flags', async () => {
  const restore = patchModel();
  try {
    let whisperArgs = null;
    const { stt, fsx, calls, logs } = setup({
      handler: (child, cmd, args) => {
        assert.equal(cmd, BINARY);                       // no afconvert: input is already 16 kHz mono
        whisperArgs = args;
        ok(child, '  [BLANK_AUDIO] (music)  run   the tests  in worktree \n');
      },
    });
    const res = await stt.transcribe({ audio: WAV_1S, format: 'wav', language: 'en', model: 'small', prompt: 'Zode, worktree' });
    assert.equal(res.ok, true);
    assert.equal(res.text, 'run the tests in worktree');   // markers gone, spaces collapsed
    assert.equal(res.language, 'en');
    assert.equal(res.model, 'small');
    assert.equal(typeof res.ms, 'number');
    assert.deepEqual(calls.map((c) => c.cmd), [BINARY]);
    assert.equal(whisperArgs[0], '-m');
    assert.equal(whisperArgs[1], MODEL_FILE);
    assert.equal(whisperArgs[2], '-f');
    assert.match(whisperArgs[3], /zode-stt-.*\.wav$/);
    assert.deepEqual(whisperArgs.slice(4), ['-nt', '-np', '-bs', '1', '-bo', '1', '-nf', '-sns', '-l', 'en', '-t', '4', '--prompt', 'Zode, worktree']);
    assert.equal(leftovers(fsx).length, 0);              // the temp wav and the raw copy are both gone
    assert.ok(!logs.join('\n').includes('run the tests'));  // the transcript is never logged
  } finally { restore(); }
});

test('non-speech-only audio transcribes to empty text', async () => {
  const restore = patchModel();
  try {
    const { stt } = setup({ handler: (child) => ok(child, '[BLANK_AUDIO]\n(music) (wind)\n') });
    const res = await stt.transcribe({ audio: WAV_1S, format: 'wav' });
    assert.equal(res.ok, true);
    assert.equal(res.text, '');
  } finally { restore(); }
});

test('m4a goes through afconvert first; whisper reads the converted wav', async () => {
  const restore = patchModel();
  try {
    const { stt, fsx, calls } = setup({
      handler: (child, cmd, args, fsx) => {
        if (cmd === AFCONVERT) {
          assert.deepEqual(args.slice(0, 6), ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1']);
          const [inPath, outPath] = args.slice(6);
          assert.match(inPath, /\.m4a$/);
          setImmediate(async () => { await fsx.promises.writeFile(outPath, WAV_1S); child.emit('close', 0); });
          return;
        }
        assert.match(args[3], /-16k\.wav$/);
        ok(child, '把这个改动 merge 进 worktree');
      },
    });
    const res = await stt.transcribe({ audio: Buffer.from('aac bytes'), format: 'm4a', language: 'zh' });
    assert.equal(res.ok, true);
    assert.equal(res.text, '把这个改动 merge 进 worktree');
    assert.equal(res.language, 'zh');
    assert.equal(calls.length, 2);
    assert.equal(leftovers(fsx).length, 0);
  } finally { restore(); }
});

test('bad-audio: empty audio, an unknown format, and an unreadable wav never reach a child', async () => {
  const restore = patchModel();
  try {
    const { stt, calls } = setup({ handler: () => assert.fail('nothing should spawn') });
    assert.equal((await stt.transcribe({ audio: Buffer.alloc(0), format: 'wav' })).code, 'bad-audio');
    assert.equal((await stt.transcribe({ audio: WAV_1S, format: 'txt' })).code, 'bad-audio');
    assert.equal((await stt.transcribe({ audio: Buffer.from('definitely not a wav'), format: 'wav' })).code, 'bad-audio');
    assert.equal(calls.length, 0);
  } finally { restore(); }
});

test('no-engine: no binary configured, nothing spawns', async () => {
  const restore = patchModel();
  try {
    const { stt, calls } = setup({ noEngine: true, handler: () => assert.fail('nothing should spawn') });
    const res = await stt.transcribe({ audio: WAV_1S, format: 'wav' });
    assert.deepEqual([res.ok, res.code], [false, 'no-engine']);
    assert.equal(calls.length, 0);
  } finally { restore(); }
});

test('no-engine: the binary path is missing on disk', async () => {
  const restore = patchModel();
  try {
    const fsx = fakeFs({ [MODEL_FILE]: MODEL_CONTENT });   // no whisper-cli entry
    const api = fakeSpawn(() => {});
    const stt = createStt({ binary: BINARY, modelDir: MODEL_DIR, tmpDir: '/tmp/stt', spawn: api.spawn, fs: fsx });
    const res = await stt.transcribe({ audio: WAV_1S, format: 'wav' });
    assert.deepEqual([res.ok, res.code], [false, 'no-engine']);
    assert.equal(api.calls.length, 0);
  } finally { restore(); }
});

test('no-model: the model file is missing', async () => {
  const restore = patchModel();
  try {
    const { stt, calls } = setup({ noModel: true, handler: () => assert.fail('nothing should spawn') });
    const res = await stt.transcribe({ audio: WAV_1S, format: 'wav' });
    assert.deepEqual([res.ok, res.code], [false, 'no-model']);
    assert.equal(calls.length, 0);
  } finally { restore(); }
});

test('bad-audio: a failing afconvert fails the request and leaves no temps', async () => {
  const restore = patchModel();
  try {
    const { stt, fsx } = setup({
      handler: (child, cmd) => {
        if (cmd === AFCONVERT) fail(child, 1, 'error: cannot convert input file');
        else assert.fail('whisper must not run');
      },
    });
    const res = await stt.transcribe({ audio: Buffer.from('aac bytes'), format: 'm4a' });
    assert.deepEqual([res.ok, res.code], [false, 'bad-audio']);
    assert.match(res.error, /afconvert/);
    assert.equal(leftovers(fsx).length, 0);
  } finally { restore(); }
});

test('too-long: more than 60 s after conversion', async () => {
  const restore = patchModel();
  try {
    const { stt, fsx } = setup({
      handler: (child, cmd, args, fsx) => {
        if (cmd === AFCONVERT) {
          setImmediate(async () => { await fsx.promises.writeFile(args[args.length - 1], WAV_61S); child.emit('close', 0); });
          return;
        }
        assert.fail('whisper must not run');
      },
    });
    const res = await stt.transcribe({ audio: Buffer.from('a long aac'), format: 'm4a' });
    assert.deepEqual([res.ok, res.code], [false, 'too-long']);
    assert.equal(leftovers(fsx).length, 0);
  } finally { restore(); }
});

test('engine-failed: a nonzero whisper exit surfaces stderr', async () => {
  const restore = patchModel();
  try {
    const { stt, fsx } = setup({
      handler: (child, cmd) => (cmd === BINARY ? fail(child, 1, 'whisper_init_from_file: failed to open model\n') : assert.fail('no conversion expected')),
    });
    const res = await stt.transcribe({ audio: WAV_1S, format: 'wav' });
    assert.deepEqual([res.ok, res.code], [false, 'engine-failed']);
    assert.match(res.error, /whisper_init_from_file/);
    assert.equal(leftovers(fsx).length, 0);
  } finally { restore(); }
});

test('timeout: the engine is SIGKILLed and the request fails with no temps left', async () => {
  const restore = patchModel();
  try {
    const { stt, fsx, children } = setup({ handler: (child, cmd) => { if (cmd !== AFCONVERT) { /* hold whisper */ } } });
    const res = await stt.transcribe({ audio: WAV_1S, format: 'wav', timeoutMs: 40 });
    assert.deepEqual([res.ok, res.code], [false, 'timeout']);
    assert.deepEqual(children[0].kills, ['SIGKILL']);
    assert.equal(leftovers(fsx).length, 0);
  } finally { restore(); }
});

test('one engine run at a time; an 11-request backlog answers busy', async () => {
  const restore = patchModel();
  try {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const { stt, fsx, calls } = setup({
      handler: (child, cmd) => { if (cmd !== AFCONVERT) gate.then(() => ok(child, 'ok')); },
    });
    const first = stt.transcribe({ audio: WAV_1S, format: 'wav' });
    await waitFor(() => calls.length === 1);
    assert.equal(calls.length, 1);                     // the second engine run waits for the first
    const rest = [];
    for (let i = 0; i < 11; i++) rest.push(stt.transcribe({ audio: WAV_1S, format: 'wav' }));
    await sleep(20);
    const codes = await Promise.all(rest.map((p) => Promise.race([p.then((r) => r.code ?? 'ok'), sleep(10).then(() => 'pending')])));
    assert.equal(codes.filter((c) => c === 'busy').length, 1);       // the 11th in line
    assert.equal(codes.filter((c) => c === 'pending').length, 10);   // the 10 the backlog holds
    release();
    const done = await Promise.all([first, ...rest]);
    assert.equal(done.filter((r) => r.ok === true).length, 11);     // first + the 10 in the backlog
    assert.equal(done.filter((r) => r.code === 'busy').length, 1);  // the one turned away
    assert.equal(calls.length, 11);
    assert.equal(leftovers(fsx).length, 0);
  } finally { restore(); }
});

test('warm: runs the engine once on a second of silence and cleans up', async () => {
  const restore = patchModel();
  try {
    let clipBytes = 0;
    const { stt, fsx, calls } = setup({
      handler: (child, cmd, args, fsx) => { clipBytes = fsx.files.get(args[args.indexOf('-f') + 1])?.length ?? 0; ok(child); },
    });
    const res = await stt.warm();
    assert.equal(res.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(clipBytes, 44 + 32000);               // one second of 16 kHz mono s16
    assert.equal(leftovers(fsx).length, 0);
  } finally { restore(); }
});

test('warm: without a model it does nothing and does not fail', async () => {
  const restore = patchModel();
  try {
    const { stt, calls } = setup({ noModel: true });
    const res = await stt.warm();
    assert.equal(res.ok, false);
    assert.equal(calls.length, 0);
  } finally { restore(); }
});

test('status: engine flag and per-model states', async () => {
  const restore = patchModel();
  try {
    const { stt } = setup({});
    const s = await stt.status();
    assert.equal(s.engine, true);
    assert.equal(s.models.small.state, 'ready');
    assert.equal(s.models['base.en'].state, 'missing');
  } finally { restore(); }
});

test('ensureModel: downloads through the injected fetch (real temp dir)', async () => {
  const restore = patchModel();
  const dir = realFs.mkdtempSync(path.join(os.tmpdir(), 'zode-stt-models-'));
  try {
    const content = Buffer.from('0123456789');
    MODELS.small.bytes = content.length;
    MODELS.small.sha256 = sha256(content);
    const urls = [];
    const fetch = async (url) => {
      urls.push(url);
      return { ok: true, status: 200, headers: { get: () => String(content.length) }, body: (async function* () { yield content; })() };
    };
    const stt = createStt({ binary: BINARY, modelDir: dir, tmpDir: '/tmp/stt', spawn: fakeSpawn().spawn, fetch });
    const res = await stt.ensureModel('small');
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.deepEqual(urls, ['https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin']);
    assert.equal(realFs.readFileSync(path.join(dir, 'ggml-small.bin')).toString(), '0123456789');
  } finally { restore(); realFs.rmSync(dir, { recursive: true, force: true }); }
});
