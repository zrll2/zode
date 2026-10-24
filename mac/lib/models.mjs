// Whisper ggml models: where they live, whether one is complete, and how to download one with
// resume. A download only takes the final name after its size and checksum passed, so whisper-cli
// can never be pointed at a half model.
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const MODEL_BASE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';

// bytes/sha256 null means the file is not pinned yet: size and checksum checks are skipped.
export const MODELS = {
  small: { file: 'ggml-small.bin', bytes: 487601967, sha256: '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b', multilingual: true },
  'base.en': { file: 'ggml-base.en.bin', bytes: null, sha256: null, multilingual: false },
};

const statSafe = async (fs, p) => { try { return await fs.promises.stat(p); } catch { return null; } };
const rmSafe = async (fs, p) => { try { await fs.promises.unlink(p); } catch { /* already gone */ } };
const describe = (err) => (err?.name === 'AbortError' || err?.code === 'ABORT_ERR' ? 'aborted' : (err?.message ?? String(err)));

export const modelUrl = (id) => `${MODEL_BASE}/${MODELS[id].file}`;

export function modelPath(id, dir) {
  const def = MODELS[id];
  if (!def) throw new Error(`unknown model: ${id}`);
  return join(dir, def.file);
}

export async function modelStatus(id, { dir, fs }) {
  const def = MODELS[id];
  if (!def) return { state: 'missing', bytes: 0 };
  const st = await statSafe(fs, join(dir, def.file));
  if (!st) return { state: 'missing', bytes: 0 };
  if (def.bytes != null && st.size !== def.bytes) return { state: 'partial', bytes: st.size };
  return { state: 'ready', bytes: st.size };
}

// Streamed through a 1 MB window so a ~490 MB model never sits in memory.
async function sha256File(fs, file) {
  const hash = createHash('sha256');
  const handle = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.alloc(1024 * 1024);
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buf, 0, buf.length, position);
      if (!bytesRead) break;
      hash.update(buf.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally { await handle.close(); }
  return hash.digest('hex');
}

// Size, then checksum, then the rename: only a verified file ever takes the final name.
async function verifyAndPlace(fs, def, partPath, finalPath) {
  const st = await statSafe(fs, partPath);
  if (!st) return { ok: false, error: 'download did not produce a file' };
  if (def.bytes != null && st.size !== def.bytes) {
    await rmSafe(fs, partPath);
    return { ok: false, error: `size mismatch: got ${st.size} bytes, expected ${def.bytes}` };
  }
  if (def.sha256) {
    const digest = await sha256File(fs, partPath);
    if (digest !== def.sha256) {
      await rmSafe(fs, partPath);
      return { ok: false, error: `checksum mismatch: got ${digest}` };
    }
  }
  try { await fs.promises.rename(partPath, finalPath); }
  catch (err) { return { ok: false, error: `rename failed: ${describe(err)}` }; }
  return { ok: true, file: finalPath, bytes: st.size };
}

export async function downloadModel(id, { dir, fetch, fs, onProgress, signal }) {
  const def = MODELS[id];
  if (!def) return { ok: false, error: `unknown model: ${id}` };
  const finalPath = join(dir, def.file);
  const partPath = `${finalPath}.part`;
  try { await fs.promises.mkdir(dir, { recursive: true }); } catch { /* exists, or the write below reports it */ }

  // Already complete: nothing to do (size only; a checksum here would re-read ~490 MB on every call).
  const done = await statSafe(fs, finalPath);
  if (done && (def.bytes == null || done.size === def.bytes)) return { ok: true, skipped: true, file: finalPath, bytes: done.size };

  // A full-sized .part only needs its checks; a longer one is corrupt and starts over.
  const part = await statSafe(fs, partPath);
  let start = part ? part.size : 0;
  if (def.bytes != null && start > def.bytes) { await rmSafe(fs, partPath); start = 0; }
  if (def.bytes != null && start === def.bytes) return await verifyAndPlace(fs, def, partPath, finalPath);

  const headers = {};
  let resume = start > 0;
  if (resume) headers.Range = `bytes=${start}-`;
  let res;
  try { res = await fetch(modelUrl(id), { headers, signal }); }
  catch (err) { return { ok: false, error: describe(err) }; }          // the .part stays for the next try
  if (!res.ok || !res.body) return { ok: false, error: `http ${res.status}` };
  if (resume && res.status !== 206) { resume = false; start = 0; }     // server ignored the Range: start over

  const contentLength = Number(res.headers?.get?.('content-length')) || 0;
  const total = resume ? start + contentLength : (contentLength || def.bytes || 0);

  let handle = null;
  try {
    handle = await fs.promises.open(partPath, resume ? 'a' : 'w');
    let received = start;
    for await (const chunk of res.body) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (!buf.length) continue;
      await handle.write(buf);
      received += buf.length;
      onProgress?.({ received, total: total || received });
    }
  } catch (err) {
    return { ok: false, error: describe(err) };                        // the .part stays for the next try
  } finally {
    try { await handle?.close(); } catch { /* already closed */ }
  }
  return await verifyAndPlace(fs, def, partPath, finalPath);
}
