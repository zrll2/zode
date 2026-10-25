// The stateless identity of a phone: the device token encrypted with the server key (that encrypted
// blob IS the push id — the service holds no table), and the per-phone secret the Mac must present
// on every push. Nothing here touches the network or the disk.
import crypto from 'node:crypto';

const b64url = (buf) => Buffer.from(buf).toString('base64url');

// The auth key is derived from the server key, so rotating the server key invalidates every secret
// along with every push id — phones re-register, which is exactly what rotation should do.
export function deriveAuthKey(serverKey) {
  return Buffer.from(crypto.hkdfSync('sha256', serverKey, Buffer.alloc(0), Buffer.from('zode-push-auth'), 32));
}

// AES-256-GCM over the JSON payload: push id = base64url(iv(12) | ciphertext | tag(16)).
export function createCodec(serverKey) {
  return {
    encrypt(payload) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', serverKey, iv);
      const ct = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
      return b64url(Buffer.concat([iv, ct, cipher.getAuthTag()]));
    },
    decrypt(pushId) {
      try {
        const raw = Buffer.from(String(pushId), 'base64url');
        if (raw.length < 12 + 16) return null;
        const iv = raw.subarray(0, 12);
        const tag = raw.subarray(raw.length - 16);
        const decipher = crypto.createDecipheriv('aes-256-gcm', serverKey, iv);
        decipher.setAuthTag(tag);
        return JSON.parse(Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString('utf8'));
      } catch {
        return null;                                            // tampered, truncated or foreign: not a push id
      }
    },
  };
}

// base64url(HMAC-SHA256(authKey, pushId)) — proof that the caller learned this push id from the phone.
export function authFor(pushId, authKey) {
  return crypto.createHmac('sha256', authKey).update(String(pushId)).digest('base64url');
}
