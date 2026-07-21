import Foundation

enum APIError: LocalizedError {
    case invalidURL
    case serverError(Int, String)

    var errorDescription: String? {
        switch self {
        case .invalidURL:
            return "서버 주소가 설정되지 않았거나 올바르지 않습니다. 설정 탭에서 URL을 확인하세요."
        case .serverError(let code, let message):
            let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? "서버 오류 (HTTP \(code))" : "서버 오류 (HTTP \(code)): \(trimmed)"
        }
    }

    /// FastAPI의 HTTPException은 오류 본문을 `{"detail": "..."}` 형태로 반환한다.
    /// 파싱 가능하면 detail만, 아니면 원문 텍스트를 그대로 메시지로 쓴다.
    static func fromResponse(statusCode: Int, data: Data) -> APIError {
        struct Detail: Decodable { let detail: String }
        if let parsed = try? JSONDecoder().decode(Detail.self, from: data) {
            return .serverError(statusCode, parsed.detail)
        }
        let raw = String(data: data, encoding: .utf8) ?? ""
        return .serverError(statusCode, raw)
    }
}
