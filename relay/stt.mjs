// Pure helpers behind the relay's stt/* rpc methods: param validation and the per-device limiter.
// The relay stays generic — the actual engine lives in the host (Zode.app passes mac/lib/stt.mjs).
export const FORMATS = ['wav', 'm4a', 'caf', 'mp3', 'ogg', 'flac'];
export const LANGUAGES = ['en', 'zh'];
export const MAX_AUDIO_BYTES = 3_000_000;      // ~45 s of watch AAC; also keeps frames under the ws limits
export const MAX_HINT_WORDS = 20;
export const MAX_HINT_CHARS = 60;

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const bad = (message) => ({ ok: false, reason: 'bad-params', message });

// Hint arrays are clamped, never refused: drop non-strings and blanks, keep the first 20, cap each at 60.
const cleanWords = (v) => (Array.isArray(v) ? v : [])
  .filter((w) => typeof w === 'string')
  .map((w) => w.trim())
  .filter((w) => w.length)
  .slice(0, MAX_HINT_WORDS)
  .map((w) => w.slice(0, MAX_HINT_CHARS));

// -> { ok: true, value: { audio: Buffer, format, language?, projects, titles } }
//    or { ok: false, reason: 'bad-params' | 'too-large', message }
export function validateTranscribe(params) {
  const p = params && typeof params === 'object' && !Array.isArray(params) ? params : {};
  if (typeof p.audio !== 'string' || !p.audio.length) return bad('audio must be a non-empty base64 string');
  if (!B64.test(p.audio) || p.audio.length % 4) return bad('audio must be valid base64');
  if (!FORMATS.includes(p.format)) return bad(`format must be one of: ${FORMATS.join(', ')}`);
  if (p.language !== undefined && !LANGUAGES.includes(p.language)) return bad("language must be 'en' or 'zh'");
  const audio = Buffer.from(p.audio, 'base64');
  if (!audio.length) return bad('audio is empty');
  if (audio.length > MAX_AUDIO_BYTES) return { ok: false, reason: 'too-large', message: `audio is larger than ${MAX_AUDIO_BYTES} bytes` };
  const hint = p.hint && typeof p.hint === 'object' && !Array.isArray(p.hint) ? p.hint : {};
  return { ok: true, value: { audio, format: p.format, language: p.language, projects: cleanWords(hint.projects), titles: cleanWords(hint.titles) } };
}

// One transcription in flight per device, at most maxPerWindow per sliding windowMs. take() admits
// (or refuses), release() frees the in-flight slot; a refused request counts toward nothing.
export function createLimiter({ now = Date.now, windowMs = 60_000, maxPerWindow = 20 } = {}) {
  const devices = new Map();                   // deviceId -> { inFlight, stamps }
  return {
    take(id) {
      const at = now();
      let d = devices.get(id);
      if (!d) devices.set(id, d = { inFlight: false, stamps: [] });
      if (d.inFlight) return false;
      d.stamps = d.stamps.filter((t) => at - t < windowMs);
      if (d.stamps.length >= maxPerWindow) return false;
      d.stamps.push(at);
      d.inFlight = true;
      return true;
    },
    release(id) { const d = devices.get(id); if (d) d.inFlight = false; },
  };
}
