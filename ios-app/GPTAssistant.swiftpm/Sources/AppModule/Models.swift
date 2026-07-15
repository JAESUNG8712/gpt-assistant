import Foundation

// 아래 모델들은 docs/API_CONTRACT.md가 저장소에 없어 ai/main.py, ai/personas.py,
// ai/memory.py의 실제 FastAPI 엔드포인트 구현을 직접 읽고 그에 맞춰 작성했다.

// MARK: - GET /personas

struct Persona: Identifiable, Decodable, Hashable {
    let id: String
    let name: String
    let icon: String
    let description: String
}

struct PersonasResponse: Decodable {
    let personas: [Persona]
}

extension Persona {
    /// 서버 연결 전(또는 오프라인)에도 페르소나 선택이 가능하도록, ai/personas.py의 PERSONAS와
    /// 동일한 목록을 기본값으로 둔다. 서버가 응답하면 이 목록은 실제 응답으로 대체된다.
    static let fallbackList: [Persona] = [
        Persona(id: "auto", name: "통합 검색", icon: "🔎", description: "질문에 맞는 전문가를 자동으로 선택"),
        Persona(id: "hr", name: "인사 전문가", icon: "👔", description: "채용·노동법·성과관리·급여 전문가"),
        Persona(id: "dev", name: "코드 개발자", icon: "💻", description: "풀스택·알고리즘·코드리뷰 전문가"),
        Persona(id: "travel", name: "여행 전문가", icon: "✈️", description: "국내외 여행 플래닝·항공·숙박 전문가"),
        Persona(id: "company", name: "사내 규정", icon: "🏢", description: "취업규칙·복무규정·사내 정책 챗봇"),
        Persona(id: "stock", name: "주식 분석", icon: "📈", description: "저평가 종목 발굴·매매 시점·수급 분석"),
        Persona(id: "resume", name: "이력서 검토", icon: "📄", description: "이력서·자기소개서 첨삭 및 커리어 조언"),
    ]
}

// MARK: - POST /chat

struct ChatRequestBody: Encodable {
    let message: String
    let persona: String
    let use_search: Bool
    let thinking_mode: String
}

// MARK: - GET /history

struct HistoryEntry: Decodable, Identifiable {
    let role: String
    let content: String
    let persona: String
    let created_at: String

    var id: String { created_at + "_" + role }
}

struct HistoryResponse: Decodable {
    let history: [HistoryEntry]
}

// MARK: - POST /feedback

struct FeedbackRequestBody: Encodable {
    let question: String
    let answer: String
    let rating: Int
    let persona: String
}

// MARK: - GET /health

// `db_exists`/`disk_free_mb`는 Turso(클라우드 DB) 모드에서는 응답에 아예 빠진다
// (ai/main.py의 /health가 로컬 SQLite일 때만 디스크 지표를 포함하므로) — 옵셔널로 둔다.
struct HealthResponse: Decodable {
    let status: String
    let db_backend: String?
    let db_exists: Bool?
    let disk_free_mb: Int?
}

// MARK: - 화면 표시용 채팅 메시지 (서버 모델과 별개)

struct ChatMessage: Identifiable, Equatable {
    enum Role: String {
        case user
        case assistant
    }

    let id = UUID()
    let role: Role
    var text: String
    var isStreaming: Bool = false
    var feedbackSent: Int? = nil
}
