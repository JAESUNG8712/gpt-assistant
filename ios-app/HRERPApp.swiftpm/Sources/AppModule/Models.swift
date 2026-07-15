import Foundation

// 아래 필드 이름/구조는 docs/API_CONTRACT.md(claude/mobile-hr-app-testing-rDc2F 브랜치)와
// 실제 server.js·public/index.html 구현(lib/collections.js의 ID_KEYED_LIST_FIELDS,
// employees.push/attendanceRecords.push/approvalDocs.push/expenseClaims.push 호출부)을
// 직접 읽어 확인한 값이다. 이 구조체들은 "표시 전용"이며 저장(POST /save)에는 절대
// 쓰지 않는다 — 서버는 클라이언트가 보낸 데이터로 전체를 덮어쓰므로, 여기서 다루지 않는
// customFields/careers/formData/attachments 같은 동적 필드까지 갖춘 Codable로
// 왕복시키면 그 필드들이 저장 시 유실된다. 실제 변경은 HRDataStore가 raw [String: Any]
// 딕셔너리를 직접 수정하는 방식으로 처리한다.

struct Employee: Decodable, Identifiable, Hashable {
    let id: Int
    let name: String
    let loginId: String?
    let empNo: String?
    let role: String?
    let dept: String?
    let team: String?
    let position: String?
    let email: String?
    let phone: String?
    let active: Bool?
}

struct LoginResponse: Decodable {
    let ok: Bool
    let employee: Employee?
    let token: String?
    let requireOtp: Bool?
    let message: String?
}

// MARK: - 근태 (attendanceRecords)

struct AttendanceRecord: Decodable, Identifiable {
    let id: String
    let empId: Int
    let date: String
    let checkIn: String?
    let checkOut: String?
    let status: String?
    let note: String?
    let updatedAt: String?
}

// MARK: - 전자결재 (approvalDocs)

struct Approver: Decodable {
    let empId: Int
    let label: String?
    let status: String  // waiting | pending | approved | rejected
    let decidedAt: String?
    let comment: String?
}

struct ApprovalDocSummary: Decodable, Identifiable {
    let id: Int
    let templateId: String?
    let authorId: Int
    let title: String
    let createdAt: String
    let updatedAt: String?
    let status: String  // in_progress | approved | rejected | cancelled
    let approvers: [Approver]
}

// MARK: - 경비청구 (expenseClaims)

struct ExpenseItem: Codable {
    let date: String?
    let category: String?
    let amount: Double
    let memo: String?
}

struct ExpenseClaim: Decodable, Identifiable {
    let id: Int
    let empId: Int
    let empName: String?
    let dept: String?
    let team: String?
    let title: String
    let items: [ExpenseItem]
    let total: Double
    let status: String  // pending | approved | rejected
    let createdAt: String
}

/// 신규 경비청구 제출 전용 — 기존 청구 건을 건드리지 않고 배열에 새로 append만 하므로
/// (다른 레코드의 동적 필드를 보존할 필요가 없으므로) 안전하게 Encodable로 왕복 가능.
struct NewExpenseClaimPayload: Encodable {
    let id: Int
    let empId: Int
    let empName: String
    let dept: String
    let team: String
    let title: String
    let items: [ExpenseItem]
    let total: Double
    let receipts: [String]
    let status: String
    let createdAt: String
}
