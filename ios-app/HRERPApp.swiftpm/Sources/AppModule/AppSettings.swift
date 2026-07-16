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

    init() {
        self.serverURLString = UserDefaults.standard.string(forKey: "hrerp.serverURLString") ?? Self.defaultServerURLString
    }

    var baseURL: URL? {
        let trimmed = serverURLString.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let normalized = trimmed.hasSuffix("/") ? String(trimmed.dropLast()) : trimmed
        guard let url = URL(string: normalized), url.scheme != nil, url.host != nil else { return nil }
        return url
    }
}
