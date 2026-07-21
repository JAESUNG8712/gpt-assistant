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

    private var inFlightReload: Task<Void, Never>?
    private var inFlightSave: Task<Bool, Never>?

    // MARK: - 읽기 전용 타입 뷰

    var employees: [Employee] { decodeArray("employees") }
    var attendanceRecords: [AttendanceRecord] { decodeArray("attendanceRecords") }
    var approvalDocs: [ApprovalDocSummary] { decodeArray("approvalDocs") }
    var expenseClaims: [ExpenseClaim] { decodeArray("expenseClaims") }
    var kpiEntries: [KPIEntry] { decodeArray("kpiEntries") }

    // MARK: - 불러오기 / 저장

    func reload(client: APIClient, session: SessionStore) async {
        // 이미 reload가 진행 중이면 그 결과를 그대로 기다린다 — reload는 서버 상태를
        // 그대로 읽어오기만 할 뿐 로컬 변경분을 실어보내는 게 아니라서, 진행 중인 reload가
        // 끝난 직후의 최신 상태를 그대로 재사용해도 안전하다(다시 요청할 필요 없음).
        if let existing = inFlightReload {
            await existing.value
            return
        }
        guard let token = session.token else { return }
        let task = Task<Void, Never> {
            self.isLoading = true
            self.lastError = nil
            defer { self.isLoading = false }
            do {
                let result = try await client.fetchData(token: token)
                self.raw = result.data
                self.version = result.version
                self.lastLoadedAt = Date()
                session.restoreEmployee(from: self.employees)
            } catch {
                if case APIError.serverError(401, _) = error {
                    session.handleUnauthorized()
                } else {
                    self.lastError = error.localizedDescription
                }
            }
        }
        inFlightReload = task
        await task.value
        inFlightReload = nil
    }

    @discardableResult
    func save(client: APIClient, session: SessionStore) async -> Bool {
        // 이미 저장이 진행 중이면, 그냥 건너뛰지 않고 그 저장이 끝나길 기다린 뒤 다시
        // 시도한다. 화면들은 대부분 "raw를 먼저 동기적으로 수정 → save() 호출" 순서로
        // 동작하기 때문에(예: 경비청구 승인 처리), 겹치는 호출을 조용히 버리면 이미 반영된
        // 로컬 변경이 서버에는 저장되지 않은 채 화면만 "처리 완료"로 보이는 불일치가 생길
        // 수 있다 — 대기 후 재시도하면 그 사이의 모든 로컬 변경이 반영된 현재 raw로 다시
        // 저장을 시도하므로 안전하다.
        if let existing = inFlightSave {
            _ = await existing.value
            return await save(client: client, session: session)
        }
        guard let token = session.token else { return false }
        let task = Task<Bool, Never> {
            self.isLoading = true
            self.lastError = nil
            defer { self.isLoading = false }
            do {
                let result = try await client.saveData(self.raw, version: self.version, token: token)
                self.version = result.version
                if result.merged, let mergedData = result.mergedData {
                    // 서버가 저장 시점 기준 최신 상태와 병합했다는 뜻 — 로컬 raw를 그 결과로
                    // 교체해 다음 화면이 다른 클라이언트의 동시 변경 내용까지 반영된 상태를
                    // 보게 한다.
                    self.raw = mergedData
                }
                return true
            } catch {
                if case APIError.serverError(401, _) = error {
                    session.handleUnauthorized()
                } else {
                    self.lastError = error.localizedDescription
                }
                return false
            }
        }
        inFlightSave = task
        let result = await task.value
        inFlightSave = nil
        return result
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

    // MARK: - 직원 관리(관리자 전용): 신규 등록 / 정보 수정 / 퇴직 처리
    // index.html의 submitHRForm()/submitHRChange()/submitRetire() 로직을 옮겼다.
    // 아래 메서드들은 role을 받거나 검증하지 않는다 — 서버의 POST /save 자체가 role 검증이
    // 없어서(README "알려진 한계" 참고), 호출 전 반드시 화면에서 role=="admin"인지 먼저
    // 확인해야 한다(경비청구/전자결재 관리자 메서드와 동일한 전제).

    /// 급여 등 `Employee`(표시 전용 Decodable, 급여 필드 의도적 제외)에 없는 필드까지
    /// 관리자 수정 화면에서 미리 채워 보여주기 위해 raw 딕셔너리를 그대로 읽는다.
    func rawEmployeeDict(id: Int) -> [String: Any]? {
        let list = raw["employees"] as? [[String: Any]] ?? []
        return list.first { ($0["id"] as? Int) == id }
    }

    func createEmployee(_ payload: NewEmployeePayload) throws {
        var list = raw["employees"] as? [[String: Any]] ?? []
        let data = try JSONEncoder().encode(payload)
        guard let dict = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw APIError.serverError(0, "직원 데이터 변환 실패")
        }
        list.append(dict)
        raw["employees"] = list
    }

    /// `changes`로 넘긴 필드만 덮어쓰고 나머지(customFields/careers 등 이 앱이 모르는 필드
    /// 포함)는 그대로 둔다. `historyDesc`가 있으면 웹 앱의 "발령·변동 이력"과 동일하게
    /// hrHistory에 감사 기록을 한 건 추가한다.
    func updateEmployee(id: Int, changes: [String: Any], historyDesc: (before: String, after: String, desc: String)?) {
        var list = raw["employees"] as? [[String: Any]] ?? []
        guard let index = list.firstIndex(where: { ($0["id"] as? Int) == id }) else { return }
        var emp = list[index]
        for (key, value) in changes { emp[key] = value }
        emp["updatedAt"] = ISO8601DateFormatter().string(from: Date())
        if let historyDesc {
            var history = emp["hrHistory"] as? [[String: Any]] ?? []
            history.append([
                "id": newClientRecordId(), "type": "update",
                "date": ISO8601DateFormatter().string(from: Date()).prefix(10).description,
                "desc": historyDesc.desc, "before": historyDesc.before, "after": historyDesc.after, "note": "",
            ])
            emp["hrHistory"] = history
        }
        list[index] = emp
        raw["employees"] = list
    }

    func retireEmployee(id: Int, date: String, reason: String, note: String) {
        var list = raw["employees"] as? [[String: Any]] ?? []
        guard let index = list.firstIndex(where: { ($0["id"] as? Int) == id }) else { return }
        var emp = list[index]
        emp["active"] = false
        emp["retireDate"] = date
        emp["retireReason"] = reason
        emp["updatedAt"] = ISO8601DateFormatter().string(from: Date())
        var history = emp["hrHistory"] as? [[String: Any]] ?? []
        history.append([
            "id": newClientRecordId(), "type": "retirement", "date": date,
            "desc": "퇴직 처리 - \(reason)", "before": "재직", "after": "퇴직 (\(date))", "note": note,
        ])
        emp["hrHistory"] = history
        list[index] = emp
        raw["employees"] = list

        // 웹 앱의 _cleanupRetiredEmpReferences()와 동일하게, 퇴직 처리 시 대기중인 경비청구를
        // 자동 반려한다. approvalDelegations/overtimeRequests는 이 앱이 다루지 않는
        // 컬렉션이라 손대지 않는다(범위 밖).
        var claims = raw["expenseClaims"] as? [[String: Any]] ?? []
        var claimsChanged = false
        for i in claims.indices {
            guard (claims[i]["empId"] as? Int) == id, (claims[i]["status"] as? String) == "pending" else { continue }
            claims[i]["status"] = "rejected"
            claims[i]["rejectReason"] = "퇴직 처리로 자동 반려"
            claims[i]["approvedAt"] = ISO8601DateFormatter().string(from: Date())
            claimsChanged = true
        }
        if claimsChanged { raw["expenseClaims"] = claims }
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
        let before = list.count
        list.removeAll { ($0["id"] as? Int) == id && (($0["status"] as? String) == "pending") }
        guard list.count != before else { return }
        raw["expenseClaims"] = list
        tombstone(field: "expenseClaims", id: id)
    }

    // MARK: - 경비청구: 관리자 정산 처리 (index.html의 approveExpenseClaim/rejectExpenseClaim/
    // payExpenseClaim을 옮김 — 서버가 empId 소유자 검증을 안 하므로, 호출 전 반드시
    // 화면에서 role=="admin"인지 먼저 확인해야 한다.)

    private func mutateExpenseClaim(id: Int, expectedStatus: String, _ mutate: (inout [String: Any]) -> Void) -> Bool {
        var list = raw["expenseClaims"] as? [[String: Any]] ?? []
        guard let index = list.firstIndex(where: { ($0["id"] as? Int) == id && ($0["status"] as? String) == expectedStatus }) else {
            return false
        }
        var claim = list[index]
        mutate(&claim)
        claim["updatedAt"] = ISO8601DateFormatter().string(from: Date())
        list[index] = claim
        raw["expenseClaims"] = list
        return true
    }

    @discardableResult
    func approveExpenseClaim(id: Int, adminName: String) -> Bool {
        mutateExpenseClaim(id: id, expectedStatus: "pending") { claim in
            claim["status"] = "approved"
            claim["approvedBy"] = adminName
            claim["approvedAt"] = ISO8601DateFormatter().string(from: Date())
        }
    }

    @discardableResult
    func rejectExpenseClaim(id: Int, adminName: String, reason: String) -> Bool {
        mutateExpenseClaim(id: id, expectedStatus: "pending") { claim in
            claim["status"] = "rejected"
            claim["rejectReason"] = reason
            claim["approvedBy"] = adminName
            claim["approvedAt"] = ISO8601DateFormatter().string(from: Date())
        }
    }

    @discardableResult
    func markExpensePaid(id: Int, payDate: String, payMethod: String, adminName: String, voucherId: String?, voucherNo: String?) -> Bool {
        mutateExpenseClaim(id: id, expectedStatus: "approved") { claim in
            claim["status"] = "paid"
            claim["paidAt"] = payDate
            claim["payMethod"] = payMethod
            claim["paidBy"] = adminName
            if let voucherId { claim["voucherId"] = voucherId }
            if let voucherNo { claim["voucherNo"] = voucherNo }
        }
    }

    // MARK: - 삭제 표시(tombstone)
    // 서버의 smartMerge는 id가 같은 레코드를 "새로운 updatedAt이 이긴다" 방식으로만 병합해서,
    // 배열에서 그냥 지운 레코드는 동시 저장 충돌 시 상대방이 여전히 갖고 있던 옛 사본이
    // 되살아날 수 있다(공식 웹 앱 `index.html`의 `_tombstone()`/`recordTombstones`와 서버의
    // `mergeRecordTombstones()`가 바로 이 문제를 막기 위해 존재함). 그래서 배열에서 레코드를
    // 지울 때는 반드시 `recordTombstones[field]`에 `{id, ts}`를 같이 남겨야 병합 시 되살아나지
    // 않는다 — 웹 앱과 동일하게 ts는 epoch 밀리초.
    private func tombstone(field: String, id: Int) {
        var tombstones = raw["recordTombstones"] as? [String: Any] ?? [:]
        var fieldList = tombstones[field] as? [[String: Any]] ?? []
        fieldList.append(["id": id, "ts": Int(Date().timeIntervalSince1970 * 1000)])
        tombstones[field] = fieldList
        raw["recordTombstones"] = tombstones
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

    // MARK: - 전자결재: 관리자 강제 반려
    // 웹 앱(index.html)에는 없는 기능 — 사용자 요청으로 추가한 관리자 전용 비상 조치.
    // 정상 결재선에 없는 관리자가 강제로 개입하는 것이므로, 대기 중인 결재자 전원을
    // "반려"로 남기고 코멘트에 관리자 이름·사유를 명시해 감사 기록이 남도록 한다
    // (호출 전 반드시 화면에서 role=="admin"인지 먼저 확인해야 한다 — decideApproval과
    // 달리 empId 소속 검증이 없다).

    @discardableResult
    func adminForceRejectApproval(docId: Int, adminName: String, reason: String) -> Bool {
        var docs = raw["approvalDocs"] as? [[String: Any]] ?? []
        guard let docIndex = docs.firstIndex(where: { ($0["id"] as? Int) == docId && ($0["status"] as? String) == "in_progress" }) else {
            return false
        }
        var doc = docs[docIndex]
        var approvers = doc["approvers"] as? [[String: Any]] ?? []
        let nowISO = ISO8601DateFormatter().string(from: Date())
        for i in approvers.indices {
            let status = approvers[i]["status"] as? String
            guard status == "pending" || status == "waiting" else { continue }
            approvers[i]["status"] = "rejected"
            approvers[i]["decidedAt"] = nowISO
            approvers[i]["comment"] = "[관리자 강제 반려 - \(adminName)] \(reason)"
        }
        doc["approvers"] = approvers
        doc["status"] = "rejected"
        doc["updatedAt"] = nowISO
        docs[docIndex] = doc
        raw["approvalDocs"] = docs
        return true
    }

    // MARK: - 평가/KPI: 목표 등록/제출, 자체평가(결과) 입력 (본인 것만)
    // index.html의 목표 등록 함수·submitKpi()·saveKpiResult()를 옮겼다. 1차/2차평가·
    // 최종확정·등급조정 등 평가자·관리자 워크플로는 여러 팀원의 KPI를 한 번에 배치 처리하고
    // 부서별 자동 등급 산정과도 얽혀 있어 범위 밖으로 뒀다(README 참고).

    func appendKPIGoal(_ payload: NewKPIGoalPayload) throws {
        var list = raw["kpiEntries"] as? [[String: Any]] ?? []
        let data = try JSONEncoder().encode(payload)
        guard let dict = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw APIError.serverError(0, "KPI 목표 데이터 변환 실패")
        }
        list.append(dict)
        raw["kpiEntries"] = list
    }

    /// 웹 앱은 목표 비중(weight) 합계가 정확히 100%가 되어야 제출을 허용한다 — 호출 전
    /// 화면에서 먼저 검증해야 한다(여기서는 다시 검증하지 않음).
    @discardableResult
    func submitKPIGoals(userId: Int, year: Int) -> Bool {
        var list = raw["kpiEntries"] as? [[String: Any]] ?? []
        var changed = false
        let nowISO = ISO8601DateFormatter().string(from: Date())
        for i in list.indices {
            guard (list[i]["userId"] as? Int) == userId, (list[i]["year"] as? Int) == year else { continue }
            list[i]["goalSub"] = 1
            list[i]["updatedAt"] = nowISO
            changed = true
        }
        guard changed else { return false }
        raw["kpiEntries"] = list
        return true
    }

    @discardableResult
    func updateKPISelfEval(id: Int, actual: String, rate: String, detail: String, selfScore: Double?) -> Bool {
        var list = raw["kpiEntries"] as? [[String: Any]] ?? []
        guard let index = list.firstIndex(where: { ($0["id"] as? Int) == id }) else { return false }
        list[index]["actual"] = actual
        list[index]["rate"] = rate
        list[index]["detail"] = detail
        list[index]["selfScore"] = selfScore ?? NSNull()
        list[index]["isDraft"] = false
        list[index]["updatedAt"] = ISO8601DateFormatter().string(from: Date())
        raw["kpiEntries"] = list
        return true
    }

    // MARK: - 평가/KPI: 평가자(팀장/사업부장/관리자) 워크플로
    // index.html의 approveFirst()/rejectKpi()/saveFirstEval()/saveSecondEval()/
    // saveFinalConfirm()을 옮겼다. 호출 전 반드시 화면에서 평가 권한(leader/director/admin +
    // 담당 범위)을 먼저 확인해야 한다 — 서버는 이 검증을 하지 않는다.

    @discardableResult
    func approveKPIFirst(id: Int) -> Bool {
        var list = raw["kpiEntries"] as? [[String: Any]] ?? []
        guard let index = list.firstIndex(where: { ($0["id"] as? Int) == id }) else { return false }
        list[index]["firstStatus"] = "approved"
        list[index]["updatedAt"] = ISO8601DateFormatter().string(from: Date())
        raw["kpiEntries"] = list
        return true
    }

    /// `stage`는 "first" 또는 "final".
    @discardableResult
    func rejectKPI(id: Int, stage: String, reason: String) -> Bool {
        var list = raw["kpiEntries"] as? [[String: Any]] ?? []
        guard let index = list.firstIndex(where: { ($0["id"] as? Int) == id }) else { return false }
        let statusKey = stage == "first" ? "firstStatus" : "finalStatus"
        let reasonKey = stage == "first" ? "firstReason" : "finalReason"
        list[index][statusKey] = "rejected"
        list[index][reasonKey] = reason
        list[index]["updatedAt"] = ISO8601DateFormatter().string(from: Date())
        raw["kpiEntries"] = list
        return true
    }

    /// `firstStatus=="approved"`인 팀원 한 명의 모든 KPI 항목에 1차 점수 + 공통 의견을
    /// 한 번에 저장한다(웹의 팀원 단위 배치 모달과 동일).
    @discardableResult
    func saveKPIFirstEval(userId: Int, year: Int, scores: [Int: Double], comment: String) -> Bool {
        var list = raw["kpiEntries"] as? [[String: Any]] ?? []
        var changed = false
        let nowISO = ISO8601DateFormatter().string(from: Date())
        for i in list.indices {
            guard (list[i]["userId"] as? Int) == userId, (list[i]["year"] as? Int) == year,
                  (list[i]["firstStatus"] as? String) == "approved",
                  let id = list[i]["id"] as? Int, let score = scores[id] else { continue }
            list[i]["firstScore"] = score
            list[i]["firstComment"] = comment
            list[i]["updatedAt"] = nowISO
            changed = true
        }
        guard changed else { return false }
        raw["kpiEntries"] = list
        return true
    }

    @discardableResult
    func saveKPISecondEval(userId: Int, year: Int, scores: [Int: Double], comment: String, isPublic: Bool) -> Bool {
        var list = raw["kpiEntries"] as? [[String: Any]] ?? []
        var changed = false
        let nowISO = ISO8601DateFormatter().string(from: Date())
        for i in list.indices {
            guard (list[i]["userId"] as? Int) == userId, (list[i]["year"] as? Int) == year,
                  (list[i]["firstStatus"] as? String) == "approved",
                  let id = list[i]["id"] as? Int, let score = scores[id] else { continue }
            list[i]["secondScore"] = score
            list[i]["secondComment"] = comment
            list[i]["secondCommentPublic"] = isPublic
            list[i]["updatedAt"] = nowISO
            changed = true
        }
        guard changed else { return false }
        raw["kpiEntries"] = list
        return true
    }

    /// 2차점수(없으면 1차점수)가 기본값으로 쓰이지만, 화면에서 항상 명시적으로 받은
    /// `finalScore`를 그대로 저장한다(웹의 최종확정 모달과 동일하게 기본값만 미리 채워줌).
    @discardableResult
    func finalizeKPI(id: Int, finalScore: Double) -> Bool {
        var list = raw["kpiEntries"] as? [[String: Any]] ?? []
        guard let index = list.firstIndex(where: { ($0["id"] as? Int) == id }) else { return false }
        list[index]["finalStatus"] = "approved"
        list[index]["finalScore"] = finalScore
        if list[index]["secondScore"] == nil {
            list[index]["secondScore"] = finalScore
        }
        list[index]["updatedAt"] = ISO8601DateFormatter().string(from: Date())
        raw["kpiEntries"] = list
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
