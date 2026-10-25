// Pushing a sealed notification to one phone through the push service (push-service/): the text is
// encrypted with that phone's pairing push key, so the service and Apple see only the kind and a
// size. Pure plus an injected `fetch`; the relay holds no push state — the push registration lives
// on the device record, the key was made at pairing.
import crypto from 'node:crypto';

export const DEFAULT_PUSH_URL = 'https://zode-push.vercel.app';      // placeholder until the service is deployed

// sealPush: base64url(iv(12) | ciphertext | tag(16)) of AES-256-GCM over the UTF-8 JSON payload,
// with the kind as AAD. openSealed is the exact inverse (the phone ports it); a wrong key, a
// tampered byte or a kind that does not match the AAD all return null.
export function sealPush(pushKey, kind, payload) {
  const key = Buffer.from(String(pushKey), 'base64url');
  if (key.length !== 32) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(String(kind), 'utf8'));
  const ct = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, ct, cipher.getAuthTag()]).toString('base64url');
}

export function openSealed(pushKey, kind, sealed) {
  try {
    const key = Buffer.from(String(pushKey), 'base64url');
    const raw = Buffer.from(String(sealed), 'base64url');
    if (key.length !== 32 || raw.length < 12 + 16) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12), { authTagLength: 16 });
    decipher.setAAD(Buffer.from(String(kind), 'utf8'));
    decipher.setAuthTag(raw.subarray(raw.length - 16));
    return JSON.parse(Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString('utf8'));
  } catch {
    return null;
  }
}

export function createPusher({ url, fetch, log, now = Date.now, activeWindowMs = 30000, retryDelayMs = 2000, timeoutMs = 8000 } = {}) {
  const base = String(url || process.env.ZODE_PUSH_URL || DEFAULT_PUSH_URL).replace(/\/+$/, '');
  const doFetch = fetch || globalThis.fetch.bind(globalThis);
  const say = log || (() => {});
  const sleep = (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref?.(); });

  async function post(body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const res = await doFetch(`${base}/api/push`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      let out = null;
      try { out = await res.json(); } catch { out = null; }
      return { status: res.status, body: out };
    } catch {
      return { status: 0, body: null };                              // unreachable or past the deadline
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    activeWindowMs,
    // Send one notification to one device. Resolves { ok: true } | { skipped: reason } |
    // { gone: true } | { error } — never throws. Logs the device id, kind and outcome only.
    async send(device, { kind, title, body, session, project, req } = {}) {
      try {
        if (!device?.pushKey || !device?.push) return { skipped: 'no-registration' };
        const text = {
          v: 1, kind, title, body,
          ...(session !== undefined ? { session } : {}),
          ...(project !== undefined ? { project } : {}),
          ...(req !== undefined ? { req } : {}),
          at: now(),
        };
        const sealed = sealPush(device.pushKey, kind, text);
        if (!sealed) return { skipped: 'seal' };
        const id = session !== undefined && session !== null ? String(session) : req ? `${req.server}:${req.id}` : '';
        const push = {
          pushId: device.push.pushId,
          auth: device.push.secret,
          kind,
          sealed,
          ...(id ? { collapseId: `${id}:${kind}`.slice(0, 64) } : {}),
        };
        let answer = await post(push);
        if (answer.status === 502 && answer.body?.retryable) {        // a serverless blip: one quiet retry
          await sleep(retryDelayMs);
          answer = await post(push);
        }
        const out = answer.status === 200 ? { ok: true }
          : answer.status === 410 || answer.body?.gone === true ? { gone: true }
          : answer.status === 0 ? { error: 'unreachable' }
          : { error: `status-${answer.status}` };
        say(`push ${kind} ${out.ok ? 'sent' : out.gone ? 'gone' : out.skipped ? `skipped (${out.skipped})` : `failed (${out.error ?? 'unknown'})`} -> ${device.id}`);
        return out;
      } catch {
        return { error: 'push-failed' };
      }
    },
  };
}
