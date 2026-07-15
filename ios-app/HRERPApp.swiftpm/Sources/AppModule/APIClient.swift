import Foundation

/// server.js(HR/ERP 시스템)용 REST 클라이언트.
/// 인증: POST /login → Bearer 토큰, 이후 모든 요청에 Authorization 헤더로 전달.
/// 핵심 데이터는 "클라이언트 신뢰형 전체 상태 블롭"(GET /data · POST /save) 패턴이라
/// 정적 타입 대신 JSONSerialization 기반 [String: Any]로 다룬다 — 이 앱이 모르는
/// 필드(coreTalentPool, orgDB, settings 등 20개 이상)까지 포함해 있는 그대로 보존해야
/// POST /save 시 데이터 유실이 없다.
final class APIClient {
    private let settings: AppSettings
    private let session: URLSession

    init(settings: AppSettings) {
        self.settings = settings
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 30
        self.session = URLSession(configuration: config)
    }

    private func url(_ path: String) throws -> URL {
        guard let base = settings.baseURL else { throw APIError.invalidURL }
        return base.appendingPathComponent(path)
    }

    // MARK: POST /login

    func login(loginId: String, password: String, otp: String?) async throws -> LoginResponse {
        var request = URLRequest(url: try url("login"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var body: [String: String] = ["loginId": loginId, "pw": password]
        if let otp, !otp.isEmpty { body["otp"] = otp }
        request.httpBody = try JSONEncoder().encode(body)

        let (data, response) = try await session.data(for: request)
        try Self.checkResponse(response, data: data)
        return try JSONDecoder().decode(LoginResponse.self, from: data)
    }

    // MARK: GET /data

    func fetchData(token: String) async throws -> (data: [String: Any], version: Int) {
        var request = URLRequest(url: try url("data"))
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        let (raw, response) = try await session.data(for: request)
        try Self.checkResponse(response, data: raw)

        guard let object = try JSONSerialization.jsonObject(with: raw) as? [String: Any],
              let data = object["data"] as? [String: Any] else {
            throw APIError.serverError(0, "GET /data 응답 형식이 올바르지 않습니다.")
        }
        let version = (object["version"] as? Int) ?? 0
        return (data, version)
    }

    // MARK: POST /save

    struct SaveResult {
        let version: Int
        let merged: Bool
        let mergedData: [String: Any]?
    }

    func saveData(_ data: [String: Any], version: Int, token: String) async throws -> SaveResult {
        var request = URLRequest(url: try url("save"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let body: [String: Any] = ["_version": version, "data": data]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (raw, response) = try await session.data(for: request)
        try Self.checkResponse(response, data: raw)

        guard let object = try JSONSerialization.jsonObject(with: raw) as? [String: Any] else {
            throw APIError.serverError(0, "POST /save 응답 형식이 올바르지 않습니다.")
        }
        let newVersion = (object["version"] as? Int) ?? version
        let merged = (object["merged"] as? Bool) ?? false
        let mergedData = object["mergedData"] as? [String: Any]
        return SaveResult(version: newVersion, merged: merged, mergedData: mergedData)
    }

    // MARK: GET /status (인증 불필요 — 로그인 화면에서 서버 연결 확인용)

    func checkStatus() async throws -> [String: Any] {
        let (raw, response) = try await session.data(from: try url("status"))
        try Self.checkResponse(response, data: raw)
        return (try? JSONSerialization.jsonObject(with: raw) as? [String: Any]) ?? [:]
    }

    private static func checkResponse(_ response: URLResponse, data: Data) throws {
        guard let http = response as? HTTPURLResponse else { return }
        guard (200..<300).contains(http.statusCode) else {
            throw APIError.fromResponse(statusCode: http.statusCode, data: data)
        }
    }
}
