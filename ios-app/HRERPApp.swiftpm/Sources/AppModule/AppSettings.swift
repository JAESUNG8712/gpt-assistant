import Foundation

/// server.js 백엔드 서버 주소. AI 어시스턴트 앱과는 별도 앱(별도 UserDefaults 스토리지)이므로
/// 키 이름이 겹쳐도 서로 영향을 주지 않는다.
final class AppSettings: ObservableObject {
    @Published var serverURLString: String {
        didSet { UserDefaults.standard.set(serverURLString, forKey: "hrerp.serverURLString") }
    }

    init() {
        self.serverURLString = UserDefaults.standard.string(forKey: "hrerp.serverURLString") ?? ""
    }

    var baseURL: URL? {
        let trimmed = serverURLString.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let normalized = trimmed.hasSuffix("/") ? String(trimmed.dropLast()) : trimmed
        guard let url = URL(string: normalized), url.scheme != nil, url.host != nil else { return nil }
        return url
    }
}
