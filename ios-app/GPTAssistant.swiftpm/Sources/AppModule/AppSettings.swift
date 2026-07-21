import Foundation

/// 백엔드(ai/main.py, FastAPI) 서버 주소와 선택된 페르소나를 앱 재실행 후에도 유지한다.
final class AppSettings: ObservableObject {
    /// 실운영 배포 주소를 기본값으로 미리 채워둔다 — Swift Playgrounds에서 매 실행마다
    /// UserDefaults가 초기화되는 경우가 있어, 빈 문자열을 기본값으로 두면 매번 다시
    /// 입력해야 하는 문제가 있었다. 다른 서버를 쓰려면 설정 화면에서 바꾸면 된다.
    static let defaultServerURLString = "https://ai-assist-aosk.onrender.com"

    @Published var serverURLString: String {
        didSet { UserDefaults.standard.set(serverURLString, forKey: "serverURLString") }
    }
    @Published var selectedPersonaID: String {
        didSet { UserDefaults.standard.set(selectedPersonaID, forKey: "selectedPersonaID") }
    }

    init() {
        let stored = UserDefaults.standard.string(forKey: "serverURLString") ?? Self.defaultServerURLString
        // 예전에 실수로 http://를 저장했던 값이 남아있으면 https로 고쳐서 되돌린다
        // (App Transport Security가 http를 차단해 요청이 조용히 실패하는 문제 재발 방지).
        self.serverURLString = Self.upgradedToHTTPS(stored)
        self.selectedPersonaID = UserDefaults.standard.string(forKey: "selectedPersonaID") ?? "hr"
    }

    private static func upgradedToHTTPS(_ value: String) -> String {
        value.hasPrefix("http://") ? "https://" + value.dropFirst("http://".count) : value
    }

    /// 저장된 문자열을 URL로 변환. 끝의 "/"는 경로 결합 시 중복 슬래시가 생기지 않도록 제거한다.
    var baseURL: URL? {
        let trimmed = Self.upgradedToHTTPS(serverURLString.trimmingCharacters(in: .whitespacesAndNewlines))
        guard !trimmed.isEmpty else { return nil }
        let normalized = trimmed.hasSuffix("/") ? String(trimmed.dropLast()) : trimmed
        guard let url = URL(string: normalized), url.scheme != nil, url.host != nil else { return nil }
        return url
    }
}
