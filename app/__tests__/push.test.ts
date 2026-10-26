import { gcm } from "@noble/ciphers/aes.js";
import { utf8ToBytes } from "@noble/ciphers/utils.js";
import {
  bytesToBase64Url,
  fromBase64Url,
  openSealed,
  parseNotificationData,
} from "../src/push";

// The fixed test vector (the Mac side asserts the same one).
const KEY_B64URL = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"; // bytes 0..31
const IV = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
const KIND = "ask";
const PLAINTEXT =
  '{"v":1,"kind":"ask","title":"web-app","body":"Run: npm test","at":1792800000000}';

function seal(key: Uint8Array, kind: string, plaintext: string, iv: Uint8Array): Uint8Array {
  const body = gcm(key, iv, utf8ToBytes(kind)).encrypt(utf8ToBytes(plaintext));
  const out = new Uint8Array(iv.length + body.length);   // the wire form: iv | ciphertext | tag
  out.set(iv);
  out.set(body, iv.length);
  return out;
}

describe("base64url helpers", () => {
  it("round-trips bytes", () => {
    const bytes = Uint8Array.from({ length: 64 }, (_, i) => (i * 37) % 256);
    expect(Array.from(fromBase64Url(bytesToBase64Url(bytes)))).toEqual(Array.from(bytes));
  });

  it("decodes the known key", () => {
    const key = fromBase64Url(KEY_B64URL);
    expect(key.length).toBe(32);
    expect(Array.from(key)).toEqual(Array.from({ length: 32 }, (_, i) => i));
  });

  it("accepts padded standard base64 too", () => {
    expect(Array.from(fromBase64Url("AAECAwQ="))).toEqual([0, 1, 2, 3, 4]);
    expect(Array.from(fromBase64Url("AAECAwQ"))).toEqual([0, 1, 2, 3, 4]);
  });
});

describe("openSealed", () => {
  it("opens the fixed test vector", () => {
    const sealed = bytesToBase64Url(seal(fromBase64Url(KEY_B64URL), KIND, PLAINTEXT, IV));
    expect(openSealed(KEY_B64URL, KIND, sealed)).toEqual({
      v: 1,
      kind: "ask",
      title: "web-app",
      body: "Run: npm test",
      at: 1792800000000,
    });
  });

  it("carries optional session, project and req", () => {
    const plaintext =
      '{"v":1,"kind":"ask","title":"t","body":"b","session":"sess_1","project":"web-app","req":{"server":"101","id":"req-9"},"at":5}';
    const sealed = bytesToBase64Url(seal(fromBase64Url(KEY_B64URL), KIND, plaintext, IV));
    expect(openSealed(KEY_B64URL, KIND, sealed)).toEqual({
      v: 1,
      kind: "ask",
      title: "t",
      body: "b",
      session: "sess_1",
      project: "web-app",
      req: { server: "101", id: "req-9" },
      at: 5,
    });
  });

  it("returns null on a flipped byte", () => {
    const sealed = bytesToBase64Url(seal(fromBase64Url(KEY_B64URL), KIND, PLAINTEXT, IV));
    const bytes = fromBase64Url(sealed);
    bytes[bytes.length - 5] ^= 0x01; // flip inside the tag
    expect(openSealed(KEY_B64URL, KIND, bytesToBase64Url(bytes))).toBeNull();
  });

  it("returns null for another kind (AAD mismatch)", () => {
    const sealed = bytesToBase64Url(seal(fromBase64Url(KEY_B64URL), KIND, PLAINTEXT, IV));
    expect(openSealed(KEY_B64URL, "done", sealed)).toBeNull();
  });

  it("returns null for a wrong key", () => {
    const otherKey = Uint8Array.from({ length: 32 }, (_, i) => 255 - i);
    const sealed = bytesToBase64Url(seal(fromBase64Url(KEY_B64URL), KIND, PLAINTEXT, IV));
    expect(openSealed(bytesToBase64Url(otherKey), KIND, sealed)).toBeNull();
  });

  it("returns null on malformed payloads and inputs", () => {
    const shortKey = bytesToBase64Url(Uint8Array.from([1, 2, 3]));
    const sealed = bytesToBase64Url(seal(fromBase64Url(KEY_B64URL), KIND, PLAINTEXT, IV));
    expect(openSealed(shortKey, KIND, sealed)).toBeNull();
    expect(openSealed(KEY_B64URL, KIND, "not-base64!!")).toBeNull();
    expect(openSealed(KEY_B64URL, KIND, "")).toBeNull();
    expect(openSealed(KEY_B64URL, KIND, bytesToBase64Url(Uint8Array.from([1, 2, 3])))).toBeNull();

    const notJson = bytesToBase64Url(seal(fromBase64Url(KEY_B64URL), KIND, "hello", IV));
    expect(openSealed(KEY_B64URL, KIND, notJson)).toBeNull();

    const wrongSchema = bytesToBase64Url(
      seal(fromBase64Url(KEY_B64URL), KIND, '{"v":2,"kind":"ask"}', IV),
    );
    expect(openSealed(KEY_B64URL, KIND, wrongSchema)).toBeNull();

    const wrongKindField = bytesToBase64Url(
      seal(fromBase64Url(KEY_B64URL), KIND, '{"v":1,"kind":"done","title":"t","body":"b","at":1}', IV),
    );
    expect(openSealed(KEY_B64URL, KIND, wrongKindField)).toBeNull();

    const badReq = bytesToBase64Url(
      seal(
        fromBase64Url(KEY_B64URL),
        KIND,
        '{"v":1,"kind":"ask","title":"t","body":"b","at":1,"req":{"id":9}}',
        IV,
      ),
    );
    expect(openSealed(KEY_B64URL, KIND, badReq)).toBeNull();
  });
});

describe("parseNotificationData", () => {
  it("reads k and s", () => {
    expect(parseNotificationData({ k: "ask", s: "sealed-text" })).toEqual({
      kind: "ask",
      sealed: "sealed-text",
    });
  });

  it("returns null for junk", () => {
    expect(parseNotificationData(null)).toBeNull();
    expect(parseNotificationData(undefined)).toBeNull();
    expect(parseNotificationData("nope")).toBeNull();
    expect(parseNotificationData({})).toBeNull();
    expect(parseNotificationData({ k: "ask" })).toBeNull();
    expect(parseNotificationData({ s: "sealed" })).toBeNull();
    expect(parseNotificationData({ k: 42, s: "sealed" })).toBeNull();
  });
});
