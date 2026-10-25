// The whole API in two pure handlers: JSON in, { status, body } out. Everything the request needs
// arrives in `deps` (crypto, limits, APNs, the clock), so tests run the whole flow with fakes and
// without a network. `serveApi` is the thin Vercel-side wrapper: method guard, body size, one log
// line per request with the route and status only.
import crypto from 'node:crypto';
import { createCodec, deriveAuthKey, authFor } from './ids.mjs';
import { createTokenSource, http2Connect, apnsSend } from './apns.mjs';
import { pushBucket, registerBucket } from './limits.mjs';

const MAX_BODY_CHARS = 8 * 1024;
const KINDS = new Set(['ask', 'question', 'failed', 'stuck', 'done']);
const GONE_REASONS = new Set(['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic']);

const isHexToken = (v) => typeof v === 'string' && /^[0-9a-fA-F]{64,200}$/.test(v);
const isB64url = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max && /^[A-Za-z0-9_-]+$/.test(v);

// Everything the handlers need, built once per instance from the environment. Returns null when the
// server key is missing or malformed: the API answers 500 instead of pretending to work.
export function defaultDeps(env = process.env) {
  let serverKey;
  try { serverKey = Buffer.from(String(env.PUSH_SERVER_KEY ?? ''), 'base64'); } catch { return null; }
  if (serverKey.length !== 32) return null;
  const authKey = deriveAuthKey(serverKey);
  return {
    codec: createCodec(serverKey),
    auth: (pushId) => authFor(pushId, authKey),
    tokenSource: env.APNS_KEY && env.APNS_KEY_ID && env.APNS_TEAM_ID
      ? createTokenSource({ key: env.APNS_KEY, keyId: env.APNS_KEY_ID, teamId: env.APNS_TEAM_ID })
      : null,
    connect: http2Connect(),
    apnsSend,
    pushLimit: pushBucket(),
    registerLimit: registerBucket(),
    topic: env.APNS_TOPIC || 'com.zode.app',
    timeoutMs: 8000,
    now: Date.now,
    log: (line) => console.log(line),             // the one allowed log line: method, route, status
  };
}

// The Vercel-side wrapper: method guard, 8 KB body cap, one call into a pure handler, one log line.
export async function serveApi({ req, res, route, method, deps, run }) {
  const respond = (code, body) => { try { res.status(code).json(body); } catch { /* the client is gone */ } };
  const done = (code, body) => { respond(code, body); deps?.log?.(`${req?.method ?? ''} ${route} ${code}`.trim()); };
  if (!req || req.method !== method) return done(405, { error: 'method-not-allowed' });
  if (!deps) return done(500, { error: 'server-error' });
  let body = {};
  if (method === 'POST') {
    body = req.body;
    let raw = '';
    try { raw = body == null ? '' : JSON.stringify(body); } catch { return done(400, { error: 'bad-request' }); }
    if (typeof body !== 'object' || body == null || Array.isArray(body) || raw.length > MAX_BODY_CHARS) {
      return done(raw.length > MAX_BODY_CHARS ? 413 : 400, raw.length > MAX_BODY_CHARS ? { error: 'too-large' } : { error: 'bad-request' });
    }
  }
  try {
    const out = await run(body);
    done(out.status, out.body);
  } catch {
    done(500, { error: 'server-error' });                        // never leak internal error text
  }
}

export function ipOf(req) {
  const raw = req?.headers?.['x-forwarded-for'] ?? req?.socket?.remoteAddress ?? 'unknown';
  return String(raw).split(',')[0].trim() || 'unknown';
}

// POST /api/register { deviceToken, env, bundleId? } -> { pushId, secret }
export async function handleRegister(input, deps) {
  const now = deps.now?.() ?? Date.now();
  if (!deps.registerLimit.take(deps.ip ?? 'unknown', now)) return { status: 429, body: { error: 'rate-limited' } };
  const b = input ?? {};
  if (!isHexToken(b.deviceToken)) return { status: 400, body: { error: 'bad-request' } };
  if (b.env !== 'production' && b.env !== 'sandbox') return { status: 400, body: { error: 'bad-request' } };
  if (b.bundleId !== undefined && (typeof b.bundleId !== 'string' || b.bundleId.length < 1 || b.bundleId.length > 200)) {
    return { status: 400, body: { error: 'bad-request' } };
  }
  const pushId = deps.codec.encrypt({ t: b.deviceToken, e: b.env, ...(b.bundleId !== undefined ? { b: b.bundleId } : {}) });
  return { status: 200, body: { pushId, secret: deps.auth(pushId) } };
}

// The visible APNs alert is a fixed placeholder: the phone's extension decrypts `s` and replaces it.
// Nothing user-specific may ever appear outside `s`. Returns the JSON string, or null past the cap.
export function buildApnsPayload(kind, sealed) {
  const payload = JSON.stringify({
    aps: {
      alert: { title: 'Zode', body: 'Open Zode' },
      'mutable-content': 1,
      ...(kind === 'done' ? {} : { sound: 'default' }),
      category: `zode.${kind}`,
      'thread-id': 'zode',
    },
    k: kind,
    s: sealed,
  });
  return Buffer.byteLength(payload) <= 4096 ? payload : null;
}

// POST /api/push { pushId, auth, kind, sealed, collapseId? } -> { ok: true } | { gone: true } | errors
export async function handlePush(input, deps) {
  const now = deps.now?.() ?? Date.now();
  const b = input ?? {};
  if (!isB64url(b.pushId, 512) || !isB64url(b.sealed, 3000) || !KINDS.has(b.kind)) {
    return { status: 400, body: { error: 'bad-request' } };
  }
  if (b.collapseId !== undefined && (typeof b.collapseId !== 'string' || b.collapseId.length < 1 || b.collapseId.length > 64)) {
    return { status: 400, body: { error: 'bad-request' } };
  }
  // The secret proves the caller got this push id from its phone; compare in constant time. A
  // missing or malformed secret is an authorization failure, not a bad request.
  const expected = Buffer.from(deps.auth(b.pushId));
  const given = typeof b.auth === 'string' ? Buffer.from(b.auth) : Buffer.alloc(0);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return { status: 401, body: { error: 'unauthorized' } };
  }
  const payload = deps.codec.decrypt(b.pushId);
  if (!payload || typeof payload.t !== 'string' || (payload.e !== 'production' && payload.e !== 'sandbox')) {
    return { status: 400, body: { error: 'bad-request' } };
  }
  if (!deps.pushLimit.take(b.pushId, now)) return { status: 429, body: { error: 'rate-limited' } };
  if (!deps.tokenSource) return { status: 500, body: { error: 'server-error' } };
  const body = buildApnsPayload(b.kind, b.sealed);
  if (body == null) return { status: 413, body: { error: 'too-large' } };

  const answer = await deps.apnsSend?.({
    connect: deps.connect,
    token: deps.tokenSource(),
    host: payload.e === 'sandbox' ? 'api.sandbox.push.apple.com' : 'api.push.apple.com',
    deviceToken: payload.t,
    bundleId: typeof payload.b === 'string' && payload.b ? payload.b : deps.topic,
    body,
    collapseId: b.collapseId,
    priority: b.kind === 'done' ? 5 : 10,
    timeoutMs: deps.timeoutMs,
  }) ?? { ok: false, error: 'no-send' };

  if (answer.ok) return { status: 200, body: { ok: true } };
  if (answer.status === 410 || (answer.status === 400 && GONE_REASONS.has(answer.reason))) {
    return { status: 410, body: { gone: true } };               // the Mac forgets this phone and re-registers later
  }
  return { status: 502, body: { error: 'upstream', retryable: true } };   // APNs 429, 5xx, timeouts, anything else
}
