import Foundation
import Security

/// 로그인 토큰(HMAC 서명, 12시간 만료)은 UserDefaults 대신 Keychain에 저장한다 —
/// 실제 인사 데이터에 접근하는 인증 토큰을 평문으로 기기에 남기지 않기 위함.
/// `ThisDeviceOnly` 접근성을 써서 iCloud Keychain 백업/동기화 대상에서 제외한다 —
/// 토큰은 이 기기에서만 유효해야 하고 다른 기기로 옮겨갈 이유가 없다.
enum KeychainTokenStore {
    private static let service = "com.jaesung8712.hrerp.authtoken"
    private static let account = "session"

    @discardableResult
    static func save(_ token: String) -> Bool {
        delete()
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecValueData as String: Data(token.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let status = SecItemAdd(query as CFDictionary, nil)
        if status != errSecSuccess {
            print("KeychainTokenStore.save 실패 (OSStatus \(status)) — 이번 실행 중엔 로그인 상태가 유지되지만 앱을 재시작하면 다시 로그인해야 합니다.")
            return false
        }
        return true
    }

    static func load() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data else {
            if status != errSecSuccess && status != errSecItemNotFound {
                print("KeychainTokenStore.load 실패 (OSStatus \(status))")
            }
            return nil
        }
        return String(data: data, encoding: .utf8)
    }

    @discardableResult
    static func delete() -> Bool {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let status = SecItemDelete(query as CFDictionary)
        if status != errSecSuccess && status != errSecItemNotFound {
            print("KeychainTokenStore.delete 실패 (OSStatus \(status))")
            return false
        }
        return true
    }
}
