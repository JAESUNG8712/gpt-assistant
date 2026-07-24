import Foundation

/// ai/main.py의 실제 엔드포인트에 맞춘 얇은 REST/스트리밍 클라이언트.
// settings(AppSettings, MainActor에서만 접근)는 baseURL을 읽는 순간에만 쓰고, session은
// URLSession(Sendable)이라 인스턴스 자체를 액터 경계 밖으로 넘겨도 안전하다 — Swift 6
// strict concurrency가 AppSettings의 비-Sendable 특성만으로 이 클래스 전체를 막는 것을
// 우회하기 위해 명시.
final class APIClient: @unchecked Sendable {
    private let settings: AppSettings
    private let session: URLSession

    init(settings: AppSettings) {
        self.settings = settings
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 30
        // 주식 분석 파이프라인 등 응답이 30~60초 이상 걸리는 경로가 있어 넉넉히 잡는다.
        config.timeoutIntervalForResource = 300
        self.session = URLSession(configuration: config)
    }

    private func url(_ path: String) throws -> URL {
        guard let base = settings.baseURL else { throw APIError.invalidURL }
        return base.appendingPathComponent(path)
    }

    // MARK: GET /personas

    func fetchPersonas() async throws -> [Persona] {
        let (data, response) = try await session.data(from: try url("personas"))
        try Self.checkResponse(response, data: data)
        return try JSONDecoder().decode(PersonasResponse.self, from: data).personas
    }

    // MARK: GET /history

    func fetchHistory(persona: String?, limit: Int = 30) async throws -> [HistoryEntry] {
        var components = URLComponents(url: try url("history"), resolvingAgainstBaseURL: false)!
        var items = [URLQueryItem(name: "limit", value: String(limit))]
        if let persona {
            items.append(URLQueryItem(name: "persona", value: persona))
        }
        components.queryItems = items

        let (data, response) = try await session.data(from: components.url!)
        try Self.checkResponse(response, data: data)
        return try JSONDecoder().decode(HistoryResponse.self, from: data).history
    }

    // MARK: DELETE /history

    func clearHistory(persona: String?) async throws {
        var components = URLComponents(url: try url("history"), resolvingAgainstBaseURL: false)!
        if let persona {
            components.queryItems = [URLQueryItem(name: "persona", value: persona)]
        }
        var request = URLRequest(url: components.url!)
        request.httpMethod = "DELETE"

        let (data, response) = try await session.data(for: request)
        try Self.checkResponse(response, data: data)
    }

    // MARK: POST /feedback

    func sendFeedback(question: String, answer: String, rating: Int, persona: String) async throws {
        var request = URLRequest(url: try url("feedback"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(
            FeedbackRequestBody(question: question, answer: answer, rating: rating, persona: persona)
        )

        let (data, response) = try await session.data(for: request)
        try Self.checkResponse(response, data: data)
    }

    // MARK: GET /health

    func checkHealth() async throws -> HealthResponse {
        let (data, response) = try await session.data(from: try url("health"))
        try Self.checkResponse(response, data: data)
        return try JSONDecoder().decode(HealthResponse.self, from: data)
    }

    // MARK: POST /chat (text/plain 스트리밍 응답)

    func streamChat(message: String, persona: String, useSearch: Bool = false) -> AsyncThrowingStream<String, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    var request = URLRequest(url: try url("chat"))
                    request.httpMethod = "POST"
                    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                    request.httpBody = try JSONEncoder().encode(
                        ChatRequestBody(message: message, persona: persona, use_search: useSearch, thinking_mode: "off")
                    )

                    let (bytes, response) = try await session.bytes(for: request)

                    if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                        var errorData = Data()
                        for try await byte in bytes { errorData.append(byte) }
                        throw APIError.fromResponse(statusCode: http.statusCode, data: errorData)
                    }

                    let decoder = IncrementalUTF8Decoder()
                    var batch: [UInt8] = []
                    batch.reserveCapacity(64)

                    for try await byte in bytes {
                        try Task.checkCancellation()
                        batch.append(byte)
                        if batch.count >= 48 {
                            let text = decoder.decode(batch)
                            batch.removeAll(keepingCapacity: true)
                            if !text.isEmpty { continuation.yield(text) }
                        }
                    }
                    if !batch.isEmpty {
                        let text = decoder.decode(batch)
                        if !text.isEmpty { continuation.yield(text) }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private static func checkResponse(_ response: URLResponse, data: Data) throws {
        guard let http = response as? HTTPURLResponse else { return }
        guard (200..<300).contains(http.statusCode) else {
            throw APIError.fromResponse(statusCode: http.statusCode, data: data)
        }
    }
}
