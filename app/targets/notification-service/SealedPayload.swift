import CryptoKit
import Foundation

// Pure decoder for the sealed push payload (W/PS contract, see src/push.ts):
// `sealed` is base64url of `iv(12) | ciphertext | tag(16)`, AES-256-GCM under
// the phone's 32-byte push key with AAD = the kind string. No UIKit.

struct SealedPayloadError: Error {}

func base64URLDecode(_ string: String) -> Data? {
    var base64 = string
        .replacingOccurrences(of: "-", with: "+")
        .replacingOccurrences(of: "_", with: "/")
    while base64.count % 4 != 0 {
        base64.append("=")
    }
    return Data(base64Encoded: base64)
}

// Returns (title, body, session) on success; nil on any tamper, wrong key,
// wrong kind (AAD mismatch), or malformed JSON.
func decodeSealedPayload(key: Data, kind: String, sealed: String) -> (title: String, body: String, session: String?)? {
    guard let sealedData = base64URLDecode(sealed) else { return nil }
    // iv(12) | ciphertext | tag(16) — CryptoKit's `combined` layout.
    guard sealedData.count > 12 + 16 else { return nil }
    let iv = sealedData.prefix(12)
    let cipherPlusTag = sealedData.dropFirst(12)
    guard let box = try? AES.GCM.SealedBox(combined: iv + cipherPlusTag) else { return nil }
    guard let opened = try? AES.GCM.open(box, using: SymmetricKey(data: key), authenticating: Data(kind.utf8)) else {
        return nil
    }
    guard let payload = try? JSONSerialization.jsonObject(with: opened) as? [String: Any] else {
        return nil
    }
    guard payload["v"] as? Int == 1 else { return nil }
    guard (payload["kind"] as? String) == kind else { return nil }
    guard let title = payload["title"] as? String, let body = payload["body"] as? String else {
        return nil
    }
    let session = payload["session"] as? String
    return (title, body, session)
}
