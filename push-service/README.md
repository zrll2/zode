# zode-push-service

A tiny stateless service that forwards sealed notifications from a user's Mac to Apple's push service (APNs). It exists because APNs needs a signing key that belongs to the app publisher; that key lives here and nowhere else. See `docs/WATCH_APP.md`, section "Push service".

**What it stores: nothing.** No database, no files, no queues. A phone's device token arrives, is encrypted with the server key, and comes back as an opaque `pushId` — the encrypted blob *is* the record. If the process dies, phones simply register again.

**What it can see: the kind, a size, and the opaque token.** The notification text is end-to-end encrypted between the Mac and the phone (a key made at pairing). The service only ever handles the ciphertext, the kind (`ask`, `question`, `failed`, `stuck`, `done`) and the visible placeholder `Zode — Open Zode`, which the phone's notification service extension replaces after decrypting. Commands, projects and conversation text never pass through here.

## API (JSON over HTTPS, POST only; other methods get 405)

- `POST /api/register` `{ deviceToken, env: 'production'|'sandbox', bundleId? }` → `{ pushId, secret }`
  - `deviceToken`: hex string, 64–200 characters.
  - `pushId` = base64url of `iv(12) | ciphertext | tag(16)` of AES-256-GCM over `{ t: token, e: env, b: bundleId }` with the server key.
  - `secret` = base64url(HMAC-SHA256(authKey, pushId)), where `authKey` is HKDF-SHA256 of the server key with info `zode-push-auth`.
- `POST /api/push` `{ pushId, auth, kind, sealed, collapseId? }` → `{ ok: true }`, `410 { gone: true }`, or errors
  - `sealed`: base64url, at most 3000 characters — the end-to-end encrypted payload.
  - `auth` must equal the HMAC for `pushId` (constant-time compare). Wrong or missing: 401.
  - Visible payload: `{ aps: { alert: { title: 'Zode', body: 'Open Zode' }, 'mutable-content': 1, sound: 'default' (except `done`), category: 'zode.<kind>', 'thread-id': 'zode' }, k: <kind>, s: <sealed> }`, capped at 4096 bytes.
  - APNs: HTTP/2, `api.push.apple.com` (production) or `api.sandbox.push.apple.com` (sandbox), path `/3/device/<token>`, bearer provider token, `apns-topic` (the registered bundle id, else `APNS_TOPIC`, else `com.zode.app`), priority 10 (5 for `done`), expiration now + 1 h.
  - Answers: APNs 200 → `{ ok: true }`; 410, or 400 with `BadDeviceToken` / `Unregistered` / `DeviceTokenNotForTopic` → `410 { gone: true }` (the Mac forgets this phone); 429/5xx/timeouts → `502 { error: 'upstream', retryable: true }`. Timeout 8 s.
- `GET /api/health` → `{ ok: true }`.

Errors: 400 `{ error: 'bad-request' }`, 401 `{ error: 'unauthorized' }`, 405 `{ error: 'method-not-allowed' }`, 413 `{ error: 'too-large' }` (body over 8 KB or payload over 4096 bytes), 429 `{ error: 'rate-limited' }`, 500 `{ error: 'server-error' }`, 502 as above. Internal error text is never in a response.

Abuse limits are in-memory per instance (30 pushes/min per push id with burst 10; 20 registrations/hour per IP) — serverless instances are short lived, so these are best effort. Logging is one line per request with the method, route and status code only; the device token, `pushId`, `auth` and `sealed` are never logged.

## Environment variables

| Name | Meaning |
|---|---|
| `PUSH_SERVER_KEY` | 32 random bytes, base64. Encrypts device tokens into push ids and derives the auth key. Required. |
| `APNS_KEY` | The APNs `.p8` key as PEM text (literal newlines or `\n` escapes both work). Required for `/api/push`. |
| `APNS_KEY_ID` | The key's id from the Apple Developer portal. |
| `APNS_TEAM_ID` | Your Apple team id. |
| `APNS_TOPIC` | Default APNs topic (bundle id); `com.zode.app` when unset. |

## Deploy

```bash
cd push-service
vercel            # link the project, then set the secrets:
vercel env add PUSH_SERVER_KEY   # base64 of 32 bytes: openssl rand -base64 32
vercel env add APNS_KEY
vercel env add APNS_KEY_ID
vercel env add APNS_TEAM_ID
vercel --prod
```

The functions are plain Node (no dependencies); `vercel.json` only raises `maxDuration` so the 8 s APNs deadline fits.

## Rotating the server key

Set a new `PUSH_SERVER_KEY`. Every existing push id stops decrypting (and every derived secret stops verifying), so all phones re-register and hand the new push id and secret to their Mac — the Mac picks it up on the next pairing sync. There is no dual-key window: rotation is a cut-over, done between turns.
