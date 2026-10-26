# Sealed push verification vector

Fixed vector shared by the Mac (push service), the phone app
(`__tests__/push.test.ts`) and this extension. `__tests__/pushVectorSwift.test.ts`
regenerates the `sealed:` line from the inputs — run `npm test` once and then
verify the Swift decoder by hand with the script at the bottom.

```
key:       AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8
key (hex): 000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f
iv (hex):  000102030405060708090a0b
kind:      ask
plaintext: {"v":1,"kind":"ask","title":"web-app","body":"Run: npm test","at":1792800000000}
sealed: AAECAwQFBgcICQoLPCCgOf_U7jnmKPnvk9NaDPC9pRjSDzYIVALHvz8eZdAscd6Mje0w-hvABs-ypXpNgGNA4yq7g65a5F47NMGUmtIG903q4x5RLGSaXt-_PpVac9RXTccMAN7BWjG_aFTF
```

## Swift check

Paste into `swift` (needs the `sealed:` line filled in by the test above):

```swift
import CryptoKit
import Foundation

func base64URLDecode(_ string: String) -> Data? {
    var base64 = string
        .replacingOccurrences(of: "-", with: "+")
        .replacingOccurrences(of: "_", with: "/")
    while base64.count % 4 != 0 { base64.append("=") }
    return Data(base64Encoded: base64)
}

let keyB64 = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
let ivHex = "000102030405060708090a0b"
let kind = "ask"
let sealedB64 = "PASTE_SEALED_HERE"

var ivBytes: [UInt8] = []
var index = ivHex.startIndex
while index < ivHex.endIndex {
    let next = ivHex.index(index, offsetBy: 2)
    ivBytes.append(UInt8(ivHex[index..<next], radix: 16)!)
    index = next
}

let key = base64URLDecode(keyB64)!
let iv = Data(ivBytes)
let sealed = base64URLDecode(sealedB64)!
let box = try AES.GCM.SealedBox(combined: iv + sealed)
let opened = try AES.GCM.open(box, using: SymmetricKey(data: key), authenticating: Data(kind.utf8))
print(String(data: opened, encoding: .utf8)!)
// Expected: {"v":1,"kind":"ask","title":"web-app","body":"Run: npm test","at":1792800000000}
```
