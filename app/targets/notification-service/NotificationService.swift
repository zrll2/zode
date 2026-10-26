import CryptoKit
import Foundation
import Security
import UserNotifications

// Reads the push key the app stored with expo-secure-store. The query must
// match its attributes exactly (SecureStoreModule.swift, query(with:)):
//   kSecClass        = kSecClassGenericPassword
//   kSecAttrService  = "app" (the default keychainService; no auth suffix
//                      because requireAuthentication is not set)
//   kSecAttrGeneric  = UTF-8 bytes of the storage key
//   kSecAttrAccount  = UTF-8 bytes of the storage key
//   kSecAttrAccessGroup = the shared access group
// and the value is stored as UTF-8 bytes of the base64url key string under
// kSecValueData.
enum PushKeyStore {
    static let accessGroup = "XP5Q8LPH52.sg.comex.zode.shared"
    private static let service = "app"
    private static let storageKey = "zode.push.key.v1"

    static func loadPushKey() -> Data? {
        let keyData = Data(storageKey.utf8)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrGeneric as String: keyData,
            kSecAttrAccount as String: keyData,
            kSecAttrAccessGroup as String: accessGroup,
            kSecMatchLimit as String: kSecMatchLimitOne,
            kSecReturnData as String: true,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess, let data = item as? Data else { return nil }
        return data
    }
}

// Decrypts the sealed payload of a push before iOS shows it. On any failure
// the unchanged placeholder content is delivered — the extension never shows
// an error and never crashes.
final class NotificationService: UNNotificationServiceExtension {
    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var content: UNMutableNotificationContent?

    override func didReceive(
        _ request: UNNotificationRequest,
        withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        self.contentHandler = contentHandler

        guard let mutable = request.content.mutableCopy() as? UNMutableNotificationContent else {
            contentHandler(request.content)
            return
        }
        content = mutable

        if
            let kind = request.content.userInfo["k"] as? String,
            let sealed = request.content.userInfo["s"] as? String,
            let key = PushKeyStore.loadPushKey(),
            let decoded = decodeSealedPayload(key: key, kind: kind, sealed: sealed)
        {
            mutable.title = decoded.title
            mutable.body = decoded.body
            mutable.threadIdentifier = decoded.session ?? "zode"
            // userInfo and categoryIdentifier are kept untouched: the app
            // still needs `k`/`s` to answer actions, and the category drives
            // the Allow/Deny/Reply buttons.
            content = mutable
        }

        contentHandler(content ?? request.content)
    }

    override func serviceExtensionTimeWillExpire() {
        if let contentHandler, let content {
            contentHandler(content)
        }
    }
}
