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
}
