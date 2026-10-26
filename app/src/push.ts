// Sealed push payloads (PS3). The push service delivers `{ k: kind, s: sealed }`
// in the notification data; `s` is base64url of `iv(12) | ciphertext | tag(16)`
// AES-256-GCM with AAD = the kind string, plaintext = a small JSON payload.
// Pure: no React, no network, never throws.

import { gcm } from "@noble/ciphers/aes.js";
import { utf8ToBytes } from "@noble/ciphers/utils.js";

export interface SealedPayload {
  v: 1;
  kind: string;
  title: string;
  body: string;
  session?: string;
  project?: string;
  req?: { server: string; id: string };
  at: number;
}

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export function bytesToBase64Url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = i + 1 < bytes.length ? (bytes[i + 1] ?? 0) : null;
    const b2 = i + 2 < bytes.length ? (bytes[i + 2] ?? 0) : null;
    out += B64URL[b0 >> 2];
    out += B64URL[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    if (b1 === null) break;
    out += B64URL[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    if (b2 === null) break;
    out += B64URL[b2 & 0x3f];
  }
  return out;
}

// Accepts base64url and plain base64 (both alphabets, padding ignored); junk
// characters are skipped so a flipped byte stays a valid-length decode that
// fails GCM instead of throwing here.
export function fromBase64Url(text: string): Uint8Array {
  const values: number[] = [];
  for (const ch of text ?? "") {
    const urlIndex = B64URL.indexOf(ch);
    if (urlIndex >= 0) {
      values.push(urlIndex);
      continue;
    }
    const stdIndex = "+/".indexOf(ch);
    if (stdIndex >= 0) {
      values.push(stdIndex + 62);
    }
  }
  const out = new Uint8Array(Math.floor((values.length * 3) / 4));
  let outIndex = 0;
  let buffer = 0;
  let bits = 0;
  for (const value of values) {
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[outIndex] = (buffer >> bits) & 0xff;
      outIndex += 1;
    }
  }
  return out.subarray(0, outIndex);
}

function bytesToUtf8(bytes: Uint8Array): string {
  if (typeof TextDecoder === "function") {
    return new TextDecoder().decode(bytes);
  }
  let result = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    result += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  try {
    return decodeURIComponent(escape(result));
  } catch {
    return "";
  }
}

// Opens a sealed payload. Returns null on any tamper, wrong key, wrong kind
// (AAD mismatch), malformed JSON, or schema miss.
export function openSealed(
  keyB64url: string,
  kind: string,
  sealedB64url: string,
): SealedPayload | null {
  try {
    const key = fromBase64Url(keyB64url);
    if (key.length !== KEY_BYTES) return null;
    const sealed = fromBase64Url(sealedB64url);
    if (sealed.length < IV_BYTES + TAG_BYTES + 2) return null;
    const iv = sealed.subarray(0, IV_BYTES);
    const cipherText = sealed.subarray(IV_BYTES);
    const plain = gcm(key, iv, utf8ToBytes(kind)).decrypt(cipherText);
    const parsed = JSON.parse(bytesToUtf8(plain)) as Record<string, unknown>;
    return validatePayload(parsed, kind);
  } catch {
    return null;
  }
}

function validatePayload(parsed: Record<string, unknown>, kind: string): SealedPayload | null {
  if (parsed.v !== 1) return null;
  if (parsed.kind !== kind) return null;
  if (typeof parsed.title !== "string" || typeof parsed.body !== "string") return null;
  if (typeof parsed.at !== "number" || !Number.isFinite(parsed.at)) return null;
  if (
    parsed.session !== undefined &&
    parsed.session !== null &&
    typeof parsed.session !== "string"
  ) {
    return null;
  }
  if (
    parsed.project !== undefined &&
    parsed.project !== null &&
    typeof parsed.project !== "string"
  ) {
    return null;
  }
  let req: { server: string; id: string } | undefined;
  if (parsed.req && typeof parsed.req === "object") {
    const candidate = parsed.req as { server?: unknown; id?: unknown };
    if (typeof candidate.server !== "string" || typeof candidate.id !== "string") return null;
    req = { server: candidate.server, id: candidate.id };
  }
  const payload: SealedPayload = {
    v: 1,
    kind,
    title: parsed.title,
    body: parsed.body,
    at: parsed.at,
  };
  if (typeof parsed.session === "string") payload.session = parsed.session;
  if (typeof parsed.project === "string") payload.project = parsed.project;
  if (req) payload.req = req;
  return payload;
}

// The notification's `data` carries the sealed payload as two strings.
export function parseNotificationData(data: unknown): { kind: string; sealed: string } | null {
  if (!data || typeof data !== "object") return null;
  const candidate = data as { k?: unknown; s?: unknown };
  if (typeof candidate.k !== "string" || !candidate.k) return null;
  if (typeof candidate.s !== "string" || !candidate.s) return null;
  return { kind: candidate.k, sealed: candidate.s };
}
