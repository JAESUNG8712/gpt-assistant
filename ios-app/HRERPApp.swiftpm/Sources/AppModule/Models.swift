import Foundation

// 아래 필드 이름/구조는 docs/API_CONTRACT.md(claude/mobile-hr-app-testing-rDc2F 브랜치)와
// 실제 server.js·public/index.html 구현(lib/collections.js의 ID_KEYED_LIST_FIELDS,
// employees.push/attendanceRecords.push/approvalDocs.push/expenseClaims.push 호출부)을
// 직접 읽어 확인한 값이다. 이 구조체들은 "표시 전용"이며 저장(POST /save)에는 절대
// 쓰지 않는다 — 서버는 클라이언트가 보낸 데이터로 전체를 덮어쓰므로, 여기서 다루지 않는
// customFields/careers/formData/attachments 같은 동적 필드까지 갖춘 Codable로
// 왕복시키면 그 필드들이 저장 시 유실된다. 실제 변경은 HRDataStore가 raw [String: Any]
// 딕셔너리를 직접 수정하는 방식으로 처리한다.

/// 새 경비청구/전자결재 문서의 id를 만들 때 쓴다. 순수 `Date().timeIntervalSince1970*1000`
/// (밀리초 타임스탬프)만 쓰면, 서로 다른 두 기기(또는 앱과 웹)가 정확히 같은 밀리초에 새
/// 레코드를 만들 경우 id가 충돌한다 — 실측 부하 테스트로 이 정확한 시나리오를 재현한 결과
/// 서버의 smartMerge가 같은 id의 두 레코드 중 하나를 아무 오류 없이 조용히 버리는 것을
/// 확인했다(동시 접속자가 많을수록 발생 확률이 올라감). 끝에 무작위 3자리를 더해 같은
/// 밀리초에 만들어져도 충돌 확률을 1/1000로 낮춘다 — 2^53(JS Number가 정밀도를 잃지 않고
/// 표현 가능한 최대 정수) 이내에 여유 있게 들어가는 크기라 서버(Node.js)와 JSON을 오가며
/// 정밀도가 깨지지 않는다.
func newClientRecordId() -> Int {
    Int(Date().timeIntervalSince1970 * 1000) * 1000 + Int.random(in: 0..<1000)
}

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
    // 상세 화면(EmployeeDetailView)에서만 쓰는 필드 — 급여(salary)는 민감정보라 의도적으로 제외.
    let birth: String?
    let gender: String?
    let hire: String?
    let jobGroup: String?
    let rank: String?
    let edu: String?
    let eduSchool: String?
    let address: String?
    let retireDate: String?
}

/// 관리자 전용 신규 직원 등록 — id는 반드시 `APIClient.nextEmployeeId(token:)`(서버 원자적
/// 발급)로 받아온 값을 써야 한다(위 주석 참고). 새 레코드만 배열에 추가하므로(기존 레코드는
/// 안 건드림) 이 앱이 모르는 필드가 없어 Encodable로 안전하게 왕복 가능.
struct NewEmployeePayload: Encodable {
    let id: Int
    let loginId: String
    let pw: String
    let name: String
    let empNo: String
    let role: String
    let dept: String
    let team: String
    let birth: String
    let gender: String
    let hire: String
    let jobGroup: String
    let rank: String
    let rankYear: Int
    let salary: Int
    let edu: String
    let eduSchool: String
    let totalCareer: Int
    let position: String
    let email: String
    let phone: String
    let address: String
    let active: Bool
    let retireDate: String
    let retireReason: String
    let customFields: [String: String]
    let careers: [String]
    let hrHistory: [String]
    let updatedAt: String
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
    /// 템플릿마다 필드 구성이 다른 동적 폼 데이터라 값 타입이 문자열이 아닐 수 있다
    /// (예: 금액이 숫자로 들어옴) — 실패해도 전체 디코딩이 깨지지 않도록 best-effort로만 채운다.
    let formData: [String: String]

    enum CodingKeys: String, CodingKey {
        case id, templateId, authorId, title, createdAt, updatedAt, status, approvers, formData
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(Int.self, forKey: .id)
        templateId = try? c.decode(String.self, forKey: .templateId)
        authorId = try c.decode(Int.self, forKey: .authorId)
        title = try c.decode(String.self, forKey: .title)
        createdAt = try c.decode(String.self, forKey: .createdAt)
        updatedAt = try? c.decode(String.self, forKey: .updatedAt)
        status = try c.decode(String.self, forKey: .status)
        approvers = (try? c.decode([Approver].self, forKey: .approvers)) ?? []
        formData = (try? c.decode([String: String].self, forKey: .formData)) ?? [:]
    }
}

// MARK: - 평가/KPI (kpiEntries) — 읽기 전용 요약만 제공
// 자기평가→1차평가→2차평가→최종확정으로 이어지는 다면평가 워크플로 전체(초안 저장,
// 점수 입력·수정, 동점자 처리 등)는 범위 밖이다. 여기서는 이미 입력된 값을 보여주기만 한다.

struct KPIEntry: Decodable, Identifiable {
    let id: Int
    let userId: Int?
    let year: Int?
    let item: String
    let weight: Double?
    let goal: String?
    let selfScore: Double?
    let firstScore: Double?
    let secondScore: Double?
    let finalScore: Double?
    let finalStatus: String?
    let isDraft: Bool?
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
    let status: String  // pending | approved | rejected | paid
    let createdAt: String
    // 관리자 정산 관리 화면에서만 쓰는 필드 — index.html의 approveExpenseClaim/
    // rejectExpenseClaim/payExpenseClaim이 채우는 것과 동일한 필드명.
    let approvedBy: String?
    let rejectReason: String?
    let paidAt: String?
    let payMethod: String?
    let voucherNo: String?
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

// MARK: - 전자결재 신규 상신

/// index.html의 "일반 결재"(tpl-general) 템플릿과 동일한 형태로 상신한다 — 제목/내용
/// 2개 필드 + 임의 인원의 순차 결재선. 템플릿별 동적 폼 전체(휴가·경비·거래처 등록 등)를
/// 재현하려면 approvalTemplates를 불러와 필드를 동적으로 그려야 해서 범위 밖으로 뒀다.
struct NewApproverPayload: Encodable {
    let empId: Int
    let label: String
    let status: String  // 1번째 항목만 "pending", 나머지는 "waiting"
    let decidedAt: String?
    let comment: String
}

struct NewApprovalDocPayload: Encodable {
    let id: Int
    let templateId: String
    let authorId: Int
    let title: String
    let createdAt: String
    let updatedAt: String
    let status: String
    let formData: [String: String]
    let approvers: [NewApproverPayload]
    let receivers: [String]
    let cc: [String]
    let attachments: [String]
}
