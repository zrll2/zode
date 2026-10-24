// The speech-to-text engine: whisper-cli (whisper.cpp) fed 16 kHz mono WAV by afconvert. One engine
// run at a time with a small backlog (`busy` beyond it); audio goes through private 0600 temp files
// that are removed on every path; the transcript is never logged, only duration, language, model
// and byte size.
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import defaultFs from 'node:fs';
import { spawn as defaultSpawn } from 'node:child_process';
import { MODELS, modelPath, modelStatus, downloadModel } from './models.mjs';

const MAX_SECONDS = 60;                    // watch prompts are short; longer clips mean a recording bug
const MAX_BACKLOG = 10;                    // queued requests before transcribe answers `busy`
const FORMATS = new Set(['wav', 'm4a', 'caf', 'mp3', 'ogg', 'flac']);
const AFCONVERT_ARGS = ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1'];   // 16 kHz mono little-endian s16

// The slice of a WAV header whisper needs: format, channels, rate, bits, and the data length in
// seconds. Null for anything whisper could not read either.
export function parseWav(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let fmt = null, dataBytes = 0;
  for (let off = 12; off + 8 <= buf.length;) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ' && off + 24 <= buf.length) {
      fmt = { format: buf.readUInt16LE(off + 8), channels: buf.readUInt16LE(off + 10), sampleRate: buf.readUInt32LE(off + 12), bits: buf.readUInt16LE(off + 22) };
    } else if (id === 'data') {
      dataBytes = size > 0 ? size : buf.length - off - 8;   // some writers leave the size at zero
      break;
    }
    off += 8 + size + (size % 2);
  }
  if (!fmt || !dataBytes || !fmt.sampleRate) return null;
  const frame = (fmt.bits / 8) * fmt.channels;
  if (!frame) return null;
  return { ...fmt, seconds: dataBytes / (fmt.sampleRate * frame) };
}

// A second of digital silence as a 16 kHz mono WAV: the warm-up clip.
export function silenceWav(sampleRate = 16000, seconds = 1) {
  const dataBytes = sampleRate * seconds * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii'); buf.writeUInt32LE(36 + dataBytes, 4); buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii'); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii'); buf.writeUInt32LE(dataBytes, 40);
  return buf;
}

// Whisper marks non-speech in brackets ([BLANK_AUDIO], [Music]) and parentheses ((music)); drop
// those, then collapse whitespace runs — segment breaks arrive as newlines.
const cleanTranscript = (raw) => String(raw)
  .replace(/\[[^\]\n]*\]/g, ' ')
  .replace(/\([^)\n]*\)/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const describe = (err) => (err?.message ?? String(err));
const lastLine = (s) => String(s ?? '').split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';

async function exists(fs, p) {
  if (!p) return false;
  try { return !!(await fs.promises.stat(p)); } catch { return false; }
}

// One child process: collect stdout/stderr, SIGKILL it when timeoutMs passes. Resolves, never
// rejects; `timedOut` tells the caller the hard stop fired.
function runProc(spawn, cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(cmd, args); } catch (err) { return resolve({ exitCode: null, stdout: '', stderr: '', error: err, timedOut: false }); }
    let stdout = '', stderr = '', settled = false, timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch { /* already gone */ } }, timeoutMs);
    const finish = (exitCode, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr, error: error ?? null, timedOut });
    };
    if (child.stdout) { child.stdout.setEncoding?.('utf8'); child.stdout.on('data', (d) => { stdout += d; }); }
    if (child.stderr) { child.stderr.setEncoding?.('utf8'); child.stderr.on('data', (d) => { stderr += d; }); }
    child.on('error', (err) => finish(null, err));
    child.on('close', (code) => finish(code, null));
  });
}

export function createStt({ binary, modelDir = join(homedir(), '.zode', 'models'), tmpDir = join(tmpdir(), 'zode-stt'), afconvert = '/usr/bin/afconvert', spawn = defaultSpawn, fs = defaultFs, log = () => {}, now = Date.now, fetch: fetchFn } = {}) {
  let seq = 0;                                   // keeps temp names unique even when now() repeats
  let running = false;
  const queue = [];

  // Serialized engine access: one whisper-cli at a time, requests resolve in queue order.
  function enqueue(task) {
    return new Promise((resolve) => {
      queue.push({ task, resolve });
      drain();
    });
  }
  function drain() {
    if (running) return;
    running = true;
    (async () => {
      while (queue.length) {
        const { task, resolve } = queue.shift();
        let out;
        try { out = await task(); }
        catch (err) { out = { ok: false, code: 'engine-failed', error: describe(err) }; }
        resolve(out);
      }
      running = false;
    })();
  }

  async function transcribe(request = {}) {
    const { audio, format = 'wav', language = 'en', model = 'small', prompt = '', timeoutMs = 20000 } = request;
    if (!Buffer.isBuffer(audio) || audio.length === 0) return { ok: false, code: 'bad-audio', error: 'no audio' };
    if (!FORMATS.has(format)) return { ok: false, code: 'bad-audio', error: `unsupported format: ${format}` };
    if (queue.length >= MAX_BACKLOG) return { ok: false, code: 'busy', error: `${queue.length} requests queued` };
    const startedAt = now();
    return enqueue(() => runTranscription({ audio, format, language, model, prompt, timeoutMs, startedAt }));
  }

  async function runTranscription({ audio, format, language, model, prompt, timeoutMs, startedAt }) {
    const temps = [];
    try {
      if (!binary || !(await exists(fs, binary))) return { ok: false, code: 'no-engine', error: 'whisper-cli not found' };
      if (!MODELS[model]) return { ok: false, code: 'no-model', error: `unknown model: ${model}` };
      const mst = await modelStatus(model, { dir: modelDir, fs });
      if (mst.state !== 'ready') return { ok: false, code: 'no-model', error: `model ${model} is ${mst.state}` };

      // Private temp copy first: afconvert and whisper read from disk, never from our memory.
      await fs.promises.mkdir(tmpDir, { recursive: true });
      const stamp = `${now().toString(36)}-${seq++}`;
      const rawPath = join(tmpDir, `zode-stt-${stamp}.${format}`);
      temps.push(rawPath);
      await fs.promises.writeFile(rawPath, audio, { mode: 0o600 });

      // Already 16 kHz mono PCM WAV goes straight in; everything else afconvert normalizes.
      let needsConversion = true;
      let wavInfo = null;
      if (format === 'wav') {
        wavInfo = parseWav(audio);
        if (!wavInfo) return { ok: false, code: 'bad-audio', error: 'unreadable wav header' };
        needsConversion = !(wavInfo.format === 1 && wavInfo.channels === 1 && wavInfo.sampleRate === 16000 && wavInfo.bits === 16);
      }
      let wavPath = rawPath;
      if (needsConversion) {
        if (!afconvert) return { ok: false, code: 'bad-audio', error: 'afconvert unavailable' };
        wavPath = join(tmpDir, `zode-stt-${stamp}-16k.wav`);
        temps.push(wavPath);                     // cleaned even when afconvert fails midway
        const conv = await runProc(spawn, afconvert, [...AFCONVERT_ARGS, rawPath, wavPath], timeoutMs);
        if (conv.timedOut) return { ok: false, code: 'bad-audio', error: 'afconvert timed out' };
        if (conv.error) return { ok: false, code: 'bad-audio', error: `afconvert: ${describe(conv.error)}` };
        if (conv.exitCode !== 0) return { ok: false, code: 'bad-audio', error: `afconvert exited ${conv.exitCode}: ${lastLine(conv.stderr)}` };
      }

      // The 60 s cap is enforced on what whisper will actually read.
      const clip = needsConversion ? parseWav(await fs.promises.readFile(wavPath)) : wavInfo;
      if (!clip) return { ok: false, code: 'bad-audio', error: 'unreadable wav after conversion' };
      if (clip.seconds > MAX_SECONDS) return { ok: false, code: 'too-long', error: `audio is ${clip.seconds.toFixed(1)} s, max ${MAX_SECONDS} s` };

      const args = ['-m', modelPath(model, modelDir), '-f', wavPath, '-nt', '-np', '-bs', '1', '-bo', '1', '-nf', '-sns', '-l', language, '-t', '4'];
      if (prompt) args.push('--prompt', prompt);
      const run = await runProc(spawn, binary, args, timeoutMs);
      if (run.timedOut) return { ok: false, code: 'timeout', error: `whisper timed out after ${timeoutMs} ms` };
      if (run.error) return { ok: false, code: run.error.code === 'ENOENT' ? 'no-engine' : 'engine-failed', error: describe(run.error) };
      if (run.exitCode !== 0) return { ok: false, code: 'engine-failed', error: (lastLine(run.stderr) || `whisper exited ${run.exitCode}`).slice(-300) };
      const ms = now() - startedAt;
      log(`stt: ok ${ms} ms lang=${language} model=${model} bytes=${audio.length}`);
      return { ok: true, text: cleanTranscript(run.stdout), ms, language, model };
    } finally {
      for (const p of temps) { try { await fs.promises.unlink(p); } catch { /* already gone */ } }
    }
  }

  async function status() {
    const models = {};
    for (const id of Object.keys(MODELS)) models[id] = await modelStatus(id, { dir: modelDir, fs });
    return { engine: await exists(fs, binary), models };
  }

  const ensureModel = (id, onProgress) => downloadModel(id, { dir: modelDir, fetch: fetchFn, fs, onProgress });

  // Pay the GPU warm-up and model load once (the first real call otherwise takes ~7 s). A warm-up
  // that cannot run is fine and quiet: it must never break anything.
  async function warm() {
    if (queue.length >= MAX_BACKLOG) return { ok: false, error: 'busy' };
    return enqueue(async () => {
      try {
        if (!binary || !(await exists(fs, binary))) return { ok: false, error: 'no engine' };
        const mst = await modelStatus('small', { dir: modelDir, fs });
        if (mst.state !== 'ready') return { ok: false, error: 'no model' };
        await fs.promises.mkdir(tmpDir, { recursive: true });
        const clip = join(tmpDir, `zode-warm-${now().toString(36)}-${seq++}.wav`);
        await fs.promises.writeFile(clip, silenceWav(), { mode: 0o600 });
        try {
          const startedAt = now();
          const run = await runProc(spawn, binary, ['-m', modelPath('small', modelDir), '-f', clip, '-nt', '-np', '-bs', '1', '-bo', '1', '-nf', '-sns', '-l', 'en', '-t', '4'], 30000);
          log(`stt: warm ${now() - startedAt} ms exit=${run.exitCode} timedOut=${run.timedOut}`);
        } finally { try { await fs.promises.unlink(clip); } catch { /* already gone */ } }
        return { ok: true };
      } catch (err) { return { ok: false, error: describe(err) }; }
    });
  }

  return { transcribe, status, ensureModel, warm };
}
