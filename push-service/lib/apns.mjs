// Talking to APNs: the provider token (an ES256 JWT APNs accepts for up to an hour; we refresh it
// every 40 minutes) and the HTTP/2 push itself. The `connect` dependency stands in for node:http2
// so tests can fake the whole exchange; the real one is at the bottom of this file.
import crypto from 'node:crypto';
import http2 from 'node:http2';

const b64url = (buf) => Buffer.from(buf).toString('base64url');

// APNs wants the signature raw (r||s), not DER — hence dsaEncoding: 'ieee-p1363'.
export function signProviderToken({ key, keyId, teamId, now = Math.floor(Date.now() / 1000) }) {
  const pem = typeof key === 'string' ? key.replace(/\\n/g, '\n') : key;
  const data = `${b64url(JSON.stringify({ alg: 'ES256', kid: keyId }))}.${b64url(JSON.stringify({ iss: teamId, iat: now }))}`;
  const sig = crypto.sign('sha256', Buffer.from(data), { key: pem, dsaEncoding: 'ieee-p1363' });
  return `${data}.${b64url(sig)}`;
}

// A fresh token between 20 and 60 minutes is APNs' rule; 40 minutes sits in the middle. `now` is
// injectable so tests can walk the clock.
export function createTokenSource({ key, keyId, teamId, now = Date.now(), ttlMs = 40 * 60 * 1000 } = {}) {
  let cached = null;
  let cachedAt = -Infinity;
  return function token() {
    const t = now();
    if (cached && t - cachedAt < ttlMs) return cached;
    cached = signProviderToken({ key, keyId, teamId, now: Math.floor(t / 1000) });
    cachedAt = t;
    return cached;
  };
}

function headersFor({ token, deviceToken, bundleId, collapseId, priority }) {
  const headers = {
    ':method': 'POST',
    ':path': `/3/device/${deviceToken}`,
    authorization: `bearer ${token}`,
    'apns-topic': bundleId,
    'apns-push-type': 'alert',
    'apns-priority': String(priority),
    'apns-expiration': String(Math.floor(Date.now() / 1000) + 3600),   // an hour: stale pushes die quietly
  };
  if (collapseId) headers['apns-collapse-id'] = collapseId;
  return headers;
}

// One push exchange. Resolves (never throws) with { ok, status?, reason?, timeout? }:
// ok:true is APNs' 200; everything else the caller maps to its own answer. The 8 s deadline covers
// the connect, the request and the answer; on timeout the session is torn down.
export async function apnsSend(opts) {
  const { connect, timeoutMs = 8000 } = opts;
  let opened = null, timedOut = false;
  const deadline = new Promise((resolve) => {
    const t = setTimeout(() => {
      timedOut = true;
      try { opened?.close?.(); } catch { /* already gone */ }          // tear the session down at the deadline
      resolve({ ok: false, timeout: true });
    }, timeoutMs);
    t.unref?.();
  });
  const work = (async () => {
    const session = await Promise.resolve().then(() => connect({ host: opts.host }));
    if (timedOut) { try { session?.close?.(); } catch { /* ignore */ } return { ok: false, timeout: true }; }   // connected after the deadline
    opened = session;
    if (!session || typeof session.request !== 'function') return { ok: false, error: 'connect' };
    return await new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (done) return; done = true; try { session.close(); } catch {} resolve(v); };
      session.on?.('error', () => finish({ ok: false, error: 'session' }));
      let req;
      try { req = session.request(headersFor(opts)); } catch { return finish({ ok: false, error: 'request' }); }
      req.on('error', () => finish({ ok: false, error: 'stream' }));
      let raw = '';
      req.setEncoding?.('utf8');
      req.on('response', (res) => {
        const status = res[':status'];
        req.on('data', (d) => { raw += d; });
        req.on('end', () => {
          let reason = null;
          try { reason = JSON.parse(raw || '{}').reason ?? null; } catch { reason = null; }
          finish({ ok: status === 200, status, reason });
        });
      });
      req.end(opts.body);
    });
  })();
  let result;
  try {
    result = await Promise.race([work, deadline]);
  } catch {
    result = { ok: false, error: 'connect' };
  }
  return result;
}

// The real thing. Errors surface on the session and are handled inside apnsSend.
export function http2Connect() {
  return ({ host }) => http2.connect(`https://${host}`);
}
