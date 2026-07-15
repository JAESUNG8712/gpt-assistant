import Foundation

enum APIError: LocalizedError {
    case invalidURL
    case notAuthenticated
    case serverError(Int, String)

    var errorDescription: String? {
        switch self {
        case .invalidURL:
            return "서버 주소가 설정되지 않았거나 올바르지 않습니다. 설정 탭에서 URL을 확인하세요."
        case .notAuthenticated:
            return "로그인이 필요합니다."
        case .serverError(let code, let message):
            let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? "서버 오류 (HTTP \(code))" : "서버 오류 (HTTP \(code)): \(trimmed)"
        }
    }

    /// server.js는 오류를 `{"ok": false, "message": "..."}` 형태로 반환한다.
    static func fromResponse(statusCode: Int, data: Data) -> APIError {
        struct Message: Decodable { let message: String? }
        if let parsed = try? JSONDecoder().decode(Message.self, from: data), let message = parsed.message {
            return .serverError(statusCode, message)
        }
        let raw = String(data: data, encoding: .utf8) ?? ""
        return .serverError(statusCode, raw)
    }
}
