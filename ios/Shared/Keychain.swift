import Foundation
import Security

/// What this phone keeps after pairing: the TV's id, this phone's own key, and where the box was found.
struct Pairing: Codable, Equatable {
    var tv: String
    var key: String
    var name: String
    var host: String
}

/// Shared by the app and its widgets / Siri actions (both are in this App Group).
enum AppGroup {
    static let id = "group.com.jaredmackay.tvremote"
    static var defaults: UserDefaults { UserDefaults(suiteName: id) ?? .standard }
}

/// The pairing lives in the Keychain (this device only), never in plain settings. It sits in the
/// App Group's keychain group so the Lock Screen and Control Center buttons can use it too.
enum PairingStore {
    private static let service = "TVRemote"
    private static let account = "pairing"

    static func load() -> Pairing? {
        var q = base()
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return try? JSONDecoder().decode(Pairing.self, from: data)
    }

    static func save(_ p: Pairing) {
        guard let data = try? JSONEncoder().encode(p) else { return }
        let q = base()
        let attrs: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        if SecItemUpdate(q as CFDictionary, attrs as CFDictionary) == errSecItemNotFound {
            var add = q
            attrs.forEach { add[$0.key] = $0.value }
            SecItemAdd(add as CFDictionary, nil)
        }
    }

    static func clear() {
        SecItemDelete(base() as CFDictionary)
    }

    private static func base() -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account,
         kSecAttrAccessGroup as String: AppGroup.id]
    }
}
