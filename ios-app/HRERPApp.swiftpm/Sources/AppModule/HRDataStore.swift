import Foundation

/// server.js의 "클라이언트 신뢰형 전체 상태 블롭"(GET /data · POST /save)을 다룬다.
///
/// 중요: 이 앱이 알고 있는 4개 컬렉션(attendanceRecords·approvalDocs·expenseClaims 일부·
/// employees는 읽기 전용) 외에도 서버에는 kpiEntries·settings·orgDB·coreTalentPool 등
/// 20개가 넘는 필드가 더 있다. `raw`는 그 전체를 그대로 들고 있다가 POST /save 때 통째로
/// 되돌려 보내는 용도이므로, 절대 타입 구조체로 디코드했다가 다시 인코드해서 되돌리지
/// 않는다(그러면 이 앱이 모르는 필드가 인코딩 과정에서 빠져 서버 데이터가 유실된다).
/// 변경은 항상 `raw` 딕셔너리의 특정 키만 직접 수정하는 방식으로 이루어진다.
@MainActor
final class HRDataStore: ObservableObject {
    @Published private(set) var raw: [String: Any] = [:]
    @Published private(set) var version: Int = 0
    @Published private(set) var lastLoadedAt: Date?
    @Published var isLoading = false
    @Published var lastError: String?

    // MARK: - 읽기 전용 타입 뷰

    var employees: [Employee] { decodeArray("employees") }
    var attendanceRecords: [AttendanceRecord] { decodeArray("attendanceRecords") }
    var approvalDocs: [ApprovalDocSummary] { decodeArray("approvalDocs") }
    var expenseClaims: [ExpenseClaim] { decodeArray("expenseClaims") }

    // MARK: - 불러오기 / 저장

    func reload(client: APIClient, session: SessionStore) async {
        guard let token = session.token else { return }
        isLoading = true
        lastError = nil
        defer { isLoading = false }
        do {
            let result = try await client.fetchData(token: token)
            raw = result.data
            version = result.version
            lastLoadedAt = Date()
            session.restoreEmployee(from: employees)
        } catch {
            if case APIError.serverError(401, _) = error {
                session.handleUnauthorized()
            } else {
                lastError = error.localizedDescription
            }
        }
    }

    @discardableResult
    func save(client: APIClient, session: SessionStore) async -> Bool {
        guard let token = session.token else { return false }
        isLoading = true
        lastError = nil
        defer { isLoading = false }
        do {
            let result = try await client.saveData(raw, version: version, token: token)
            version = result.version
            if result.merged, let mergedData = result.mergedData {
                // 서버가 저장 시점 기준 최신 상태와 병합했다는 뜻 — 로컬 raw를 그 결과로 교체해
                // 다음 화면이 다른 클라이언트의 동시 변경 내용까지 반영된 상태를 보게 한다.
                raw = mergedData
            }
            return true
        } catch {
            if case APIError.serverError(401, _) = error {
                session.handleUnauthorized()
            } else {
                lastError = error.localizedDescription
            }
            return false
        }
    }

    // MARK: - 근태: 출근/퇴근 체크 (오늘 레코드가 있으면 갱신, 없으면 새로 추가)

    func checkIn(empId: Int, date: String, time: String) {
        upsertAttendance(empId: empId, date: date) { $0["checkIn"] = time }
    }

    func checkOut(empId: Int, date: String, time: String) {
        upsertAttendance(empId: empId, date: date) { $0["checkOut"] = time }
    }

    private func upsertAttendance(empId: Int, date: String, mutate: (inout [String: Any]) -> Void) {
        var list = raw["attendanceRecords"] as? [[String: Any]] ?? []
        let nowISO = ISO8601DateFormatter().string(from: Date())
        if let index = list.firstIndex(where: { ($0["empId"] as? Int) == empId && ($0["date"] as? String) == date }) {
            var record = list[index]
            mutate(&record)
            record["updatedAt"] = nowISO
            list[index] = record
        } else {
            var record: [String: Any] = [
                "id": "att-\(empId)-\(date)", "empId": empId, "date": date,
                "checkIn": "", "checkOut": "", "status": "normal", "note": "",
            ]
            mutate(&record)
            record["updatedAt"] = nowISO
            list.append(record)
        }
        raw["attendanceRecords"] = list
    }

    // MARK: - 경비청구: 신규 제출 (기존 청구 건은 손대지 않고 배열에 추가만 함)

    func appendExpenseClaim(_ payload: NewExpenseClaimPayload) throws {
        var list = raw["expenseClaims"] as? [[String: Any]] ?? []
        let data = try JSONEncoder().encode(payload)
        guard let dict = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw APIError.serverError(0, "경비청구 데이터 변환 실패")
        }
        list.append(dict)
        raw["expenseClaims"] = list
    }

    func withdrawExpenseClaim(id: Int) {
        var list = raw["expenseClaims"] as? [[String: Any]] ?? []
        list.removeAll { ($0["id"] as? Int) == id && (($0["status"] as? String) == "pending") }
        raw["expenseClaims"] = list
    }

    // MARK: - 전자결재: 신규 상신 (기존 문서는 손대지 않고 배열에 추가만 함)

    func appendApprovalDoc(_ payload: NewApprovalDocPayload) throws {
        var list = raw["approvalDocs"] as? [[String: Any]] ?? []
        let data = try JSONEncoder().encode(payload)
        guard let dict = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw APIError.serverError(0, "결재 문서 데이터 변환 실패")
        }
        list.append(dict)
        raw["approvalDocs"] = list
    }

    // MARK: - 전자결재: 승인/반려
    // ai/index.html의 approveApprovalDoc()/rejectApprovalDoc() 로직을 그대로 옮김:
    // 승인 시 다음 "waiting" 결재자를 "pending"으로 올리고, 더 없으면 문서 상태를 approved로.
    // 반려 시 즉시 문서 상태를 rejected로. (근태신청 자동반영 등 템플릿별 부가 효과는 미구현.)

    enum ApprovalAction { case approve, reject }

    @discardableResult
    func decideApproval(docId: Int, empId: Int, action: ApprovalAction, comment: String) -> Bool {
        var docs = raw["approvalDocs"] as? [[String: Any]] ?? []
        guard let docIndex = docs.firstIndex(where: { ($0["id"] as? Int) == docId }) else { return false }
        var doc = docs[docIndex]
        var approvers = doc["approvers"] as? [[String: Any]] ?? []
        guard let approverIndex = approvers.firstIndex(where: {
            ($0["empId"] as? Int) == empId && ($0["status"] as? String) == "pending"
        }) else { return false }

        let nowISO = ISO8601DateFormatter().string(from: Date())
        approvers[approverIndex]["decidedAt"] = nowISO
        approvers[approverIndex]["comment"] = comment

        switch action {
        case .approve:
            approvers[approverIndex]["status"] = "approved"
            if let nextIndex = approvers.firstIndex(where: { ($0["status"] as? String) == "waiting" }) {
                approvers[nextIndex]["status"] = "pending"
            } else {
                doc["status"] = "approved"
            }
        case .reject:
            approvers[approverIndex]["status"] = "rejected"
            doc["status"] = "rejected"
        }

        doc["approvers"] = approvers
        doc["updatedAt"] = nowISO
        docs[docIndex] = doc
        raw["approvalDocs"] = docs
        return true
    }

    // MARK: - 변환 헬퍼

    private func decodeArray<T: Decodable>(_ key: String) -> [T] {
        guard let array = raw[key] as? [[String: Any]] else { return [] }
        return array.compactMap { dict in
            guard let data = try? JSONSerialization.data(withJSONObject: dict) else { return nil }
            return try? JSONDecoder().decode(T.self, from: data)
        }
    }
}
