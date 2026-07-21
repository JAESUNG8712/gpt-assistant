import Foundation

/// server.js 백엔드 서버 주소. AI 어시스턴트 앱과는 별도 앱(별도 UserDefaults 스토리지)이므로
/// 키 이름이 겹쳐도 서로 영향을 주지 않는다.
final class AppSettings: ObservableObject {
    /// 예전에는 실운영 배포 주소를 기본값으로 미리 채워뒀으나, 이 앱을 앱스토어 등으로
    /// 배포하면 다운로드한 누구나 기본값 그대로 실제 회사의 운영 데이터에 접속하게 되는
    /// 심각한 문제가 있어 제거했다(멀티테넌트 전환 전까지는 절대 실운영 주소를 기본값으로
    /// 두면 안 됨). 서버 주소는 항상 설정 화면에서 사용자가 직접 입력해야 한다.
    static let defaultServerURLString = ""

    @Published var serverURLString: String {
        didSet { UserDefaults.standard.set(serverURLString, forKey: "hrerp.serverURLString") }
    }

    init() {
        let stored = UserDefaults.standard.string(forKey: "hrerp.serverURLString") ?? Self.defaultServerURLString
        // 예전에 실수로 http://를 저장했던 값이 남아있으면 https로 고쳐서 되돌린다
        // (App Transport Security가 http를 차단해 로그인이 조용히 실패하는 문제 재발 방지).
        self.serverURLString = Self.upgradedToHTTPS(stored)
    }

    private static func upgradedToHTTPS(_ value: String) -> String {
        value.hasPrefix("http://") ? "https://" + value.dropFirst("http://".count) : value
    }

    var baseURL: URL? {
        let trimmed = Self.upgradedToHTTPS(serverURLString.trimmingCharacters(in: .whitespacesAndNewlines))
        guard !trimmed.isEmpty else { return nil }
        let normalized = trimmed.hasSuffix("/") ? String(trimmed.dropLast()) : trimmed
        guard let url = URL(string: normalized), url.scheme != nil, url.host != nil else { return nil }
        return url
    }
}
