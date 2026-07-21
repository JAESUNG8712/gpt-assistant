import Foundation

/// server.js 백엔드 서버 주소. AI 어시스턴트 앱과는 별도 앱(별도 UserDefaults 스토리지)이므로
/// 키 이름이 겹쳐도 서로 영향을 주지 않는다.
final class AppSettings: ObservableObject {
    /// 실운영 배포 주소를 기본값으로 미리 채워둔다 — Swift Playgrounds에서 매 실행마다
    /// UserDefaults가 초기화되는 경우가 있어, 빈 문자열을 기본값으로 두면 매번 다시
    /// 입력해야 하는 문제가 있었다. 다른 서버를 쓰려면 설정 화면에서 바꾸면 된다.
    static let defaultServerURLString = "https://hrsystem-uweb.onrender.com"

    @Published var serverURLString: String {
        didSet { UserDefaults.standard.set(serverURLString, forKey: "hrerp.serverURLString") }
    }

    /// 서버가 어느 시점부터 `POST /login`에 회사 코드 필드를 추가로 요구하기 시작했다
    /// (기존엔 아이디/비밀번호만으로 로그인됐음). 회사마다 값이 다를 수 있어 서버 주소처럼
    /// 매번 다시 입력하지 않도록 저장해둔다.
    @Published var companyCode: String {
        didSet { UserDefaults.standard.set(companyCode, forKey: "hrerp.companyCode") }
    }

    init() {
        let stored = UserDefaults.standard.string(forKey: "hrerp.serverURLString") ?? Self.defaultServerURLString
        // 예전에 실수로 http://를 저장했던 값이 남아있으면 https로 고쳐서 되돌린다
        // (App Transport Security가 http를 차단해 로그인이 조용히 실패하는 문제 재발 방지).
        self.serverURLString = Self.upgradedToHTTPS(stored)
        self.companyCode = UserDefaults.standard.string(forKey: "hrerp.companyCode") ?? ""
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
