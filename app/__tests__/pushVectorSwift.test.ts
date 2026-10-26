import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { gcm } from "@noble/ciphers/aes.js";
import { utf8ToBytes } from "@noble/ciphers/utils.js";
import { bytesToBase64Url, fromBase64Url, openSealed } from "../src/push";

// The fixed vector from the PS3 contract (the Mac side asserts the same one).
// This test seals it with the phone's exact recipe and regenerates the
// `sealed:` line in targets/notification-service/VECTOR.md so the Swift
// decoder of the notification service extension can be verified by hand.
const KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"; // bytes 0..31
const IV = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
const KIND = "ask";
const PLAINTEXT = '{"v":1,"kind":"ask","title":"web-app","body":"Run: npm test","at":1792800000000}';

const VECTOR_FILE = path.join(__dirname, "..", "targets", "notification-service", "VECTOR.md");

it("produces the fixed sealed vector and keeps VECTOR.md in sync", () => {
  const sealed = bytesToBase64Url(
    gcm(fromBase64Url(KEY), IV, utf8ToBytes(KIND)).encrypt(utf8ToBytes(PLAINTEXT)),
  );

  // The phone-side decoder must round-trip exactly this string.
  expect(openSealed(KEY, KIND, sealed)).toEqual({
    v: 1,
    kind: "ask",
    title: "web-app",
    body: "Run: npm test",
    at: 1792800000000,
  });

  // Write the sealed line into the vector table (deterministic content, so
  // this is a no-op once the test has run).
  const current = readFileSync(VECTOR_FILE, "utf8");
  const updated = current.replace(/^sealed: .*$/m, `sealed: ${sealed}`);
  if (updated !== current) writeFileSync(VECTOR_FILE, updated, "utf8");
  const verified = readFileSync(VECTOR_FILE, "utf8");
  expect(verified).toContain(`sealed: ${sealed}`);
  expect(verified).toMatch(/^key:\s+AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8$/m);
  expect(verified).toMatch(/^iv \(hex\):\s+000102030405060708090a0b$/m);
  expect(verified).toMatch(/^kind:\s+ask$/m);
  expect(verified).toContain(PLAINTEXT);
});
