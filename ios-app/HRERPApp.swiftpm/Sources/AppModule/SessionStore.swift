import Foundation

@MainActor
final class SessionStore: ObservableObject {
    @Published private(set) var token: String?
    @Published private(set) var currentEmployee: Employee?
    @Published var isLoggingIn = false
    @Published var loginError: String?

    init() {
        self.token = KeychainTokenStore.load()
        // 토큰은 있지만 직원 정보는 메모리에 없는 상태(앱 재시작 직후) — 첫 /data 호출이
        // 성공하면 그대로 세션을 유지하고, 401이 나면 401 핸들러가 로그아웃 처리한다.
    }

    var isAuthenticated: Bool { token != nil }

    func login(loginId: String, password: String, otp: String?, companyCode: String?, client: APIClient) async -> Bool {
        isLoggingIn = true
        loginError = nil
        defer { isLoggingIn = false }
        do {
            let response = try await client.login(loginId: loginId, password: password, otp: otp, companyCode: companyCode)
            if response.requireOtp == true {
                loginError = response.message ?? "2단계 인증 코드를 입력하세요."
                return false
            }
            guard response.ok, let token = response.token, let employee = response.employee else {
                loginError = response.message ?? "로그인에 실패했습니다."
                return false
            }
            self.token = token
            self.currentEmployee = employee
            KeychainTokenStore.save(token)
            return true
        } catch {
            loginError = error.localizedDescription
            return false
        }
    }

    func logout() {
        token = nil
        currentEmployee = nil
        KeychainTokenStore.delete()
    }

    /// 서버가 401을 반환하면(토큰 12시간 만료 등) 세션을 정리하고 로그인 화면으로 돌린다.
    func handleUnauthorized() {
        logout()
    }

    /// 앱 재시작 직후에는 Keychain에 토큰만 있고 직원 정보가 메모리에 없다.
    /// 토큰 본문(서명 앞부분, base64url JSON — 서버 시크릿 없이도 읽을 수 있는 평문 payload)에서
    /// empId를 꺼내 GET /data로 받아온 employees 목록에서 본인을 찾아 복원한다.
    /// (서명 검증은 하지 않는다 — 어차피 서버가 모든 요청에서 검증하므로, 여기서는 표시용으로만 쓴다.)
    func restoreEmployee(from employees: [Employee]) {
        guard currentEmployee == nil, let token, let empId = Self.decodeTokenEmpId(token) else { return }
        currentEmployee = employees.first(where: { $0.id == empId })
    }

    private static func decodeTokenEmpId(_ token: String) -> Int? {
        guard let bodySubstring = token.split(separator: ".").first else { return nil }
        var base64 = String(bodySubstring)
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        while base64.count % 4 != 0 { base64 += "=" }
        guard let data = Data(base64Encoded: base64),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        return object["empId"] as? Int
    }
}
