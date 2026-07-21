import SwiftUI

@MainActor
struct EmployeeDetailView: View {
    @EnvironmentObject private var settings: AppSettings
    @EnvironmentObject private var session: SessionStore
    @ObservedObject var store: HRDataStore
    let employeeId: Int
    let reload: () async -> Void

    @State private var showingEdit = false
    @State private var showingRetire = false
    @State private var showingResetPassword = false
    @State private var showingHRChange = false

    private var employee: Employee? { store.employees.first { $0.id == employeeId } }
    private var isAdmin: Bool { session.currentEmployee?.role == "admin" }

    var body: some View {
        Group {
            if let employee {
                AppScreen {
                    HStack(spacing: 14) {
                        ZStack {
                            Circle().fill(AppTheme.accentLight).frame(width: 56, height: 56)
                            Text(String(employee.name.prefix(1)))
                                .font(.title3.weight(.bold))
                                .foregroundStyle(AppTheme.accentDark)
                        }
                        VStack(alignment: .leading, spacing: 2) {
                            Text(employee.name).font(.title3.weight(.bold)).foregroundStyle(AppTheme.primaryText)
                            Text([employee.dept, employee.team, employee.position].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                                .font(.caption)
                                .foregroundStyle(AppTheme.secondaryText)
                        }
                        Spacer()
                        if employee.active == false {
                            Text("퇴사").font(.caption.weight(.semibold)).foregroundStyle(AppTheme.secondaryText)
                        }
                    }

                    AppCard(title: "기본 정보") {
                        row("사번", employee.empNo)
                        row("아이디", employee.loginId)
                        row("역할", roleLabel(employee.role))
                        row("직군", employee.jobGroup)
                        row("직급", employee.rank)
                    }

                    AppCard(title: "연락처") {
                        row("이메일", employee.email)
                        row("전화번호", employee.phone)
                        row("주소", employee.address)
                    }

                    AppCard(title: "인사 정보") {
                        row("입사일", employee.hire)
                        row("생년월일", employee.birth)
                        row("성별", employee.gender)
                        row("최종학력", employee.edu)
                        row("출신학교", employee.eduSchool)
                        if employee.active == false {
                            row("퇴직일", employee.retireDate)
                        }
                    }
                }
                .navigationTitle(employee.name)
                .toolbar {
                    if isAdmin {
                        ToolbarItem(placement: .primaryAction) {
                            Menu {
                                Button {
                                    showingEdit = true
                                } label: {
                                    Label("정보 수정", systemImage: "pencil")
                                }
                                Button {
                                    showingHRChange = true
                                } label: {
                                    Label("발령·변동 이력 등록", systemImage: "arrow.left.arrow.right")
                                }
                                Button {
                                    showingResetPassword = true
                                } label: {
                                    Label("비밀번호 재설정", systemImage: "key")
                                }
                                if employee.active != false {
                                    Button(role: .destructive) {
                                        showingRetire = true
                                    } label: {
                                        Label("퇴직 처리", systemImage: "person.fill.xmark")
                                    }
                                }
                            } label: {
                                Image(systemName: "ellipsis.circle")
                            }
                        }
                    }
                }
                .sheet(isPresented: $showingEdit) {
                    EditEmployeeView(store: store, employeeId: employeeId) {
                        Task { await reload() }
                    }
                    .environmentObject(settings)
                    .environmentObject(session)
                }
                .sheet(isPresented: $showingRetire) {
                    RetireEmployeeView(store: store, employee: employee) {
                        Task { await reload() }
                    }
                    .environmentObject(settings)
                    .environmentObject(session)
                }
                .sheet(isPresented: $showingResetPassword) {
                    ResetPasswordView(store: store, employee: employee) {
                        Task { await reload() }
                    }
                    .environmentObject(settings)
                    .environmentObject(session)
                }
                .sheet(isPresented: $showingHRChange) {
                    HRChangeView(store: store, employee: employee) {
                        Task { await reload() }
                    }
                    .environmentObject(settings)
                    .environmentObject(session)
                }
            } else {
                EmptyState(message: "직원 정보를 찾을 수 없습니다.")
            }
        }
    }

    @ViewBuilder
    private func row(_ label: String, _ value: String?) -> some View {
        if let value, !value.isEmpty {
            LabeledContent(label, value: value)
        }
    }

    private func roleLabel(_ role: String?) -> String? {
        switch role {
        case "admin": return "관리자"
        case "director": return "임원"
        case "leader": return "팀장"
        case "member": return "팀원"
        default: return role
        }
    }
}

private let editableFieldLabels: [String: String] = [
    "loginId": "로그인ID", "dept": "부서", "team": "팀", "role": "역할", "jobGroup": "직군", "rank": "직급",
    "rankYear": "직급연차", "position": "직책", "salary": "연봉", "email": "이메일",
    "phone": "전화번호", "address": "주소",
]

/// 일반 정보 즉시 수정용 — 바뀐 필드만 모아 hrHistory에 감사 기록 한 건을 남긴다.
/// 유형별 전용 폼(전보/연봉/승진/직급변동/직책)과 미래 날짜 예약 적용은 이 파일 하단의
/// `HRChangeView`(index.html의 submitHRChange 이식)가 따로 담당한다.
@MainActor
private struct EditEmployeeView: View {
    @EnvironmentObject private var settings: AppSettings
    @EnvironmentObject private var session: SessionStore
    @ObservedObject var store: HRDataStore
    let employeeId: Int
    let onSaved: () -> Void
    @Environment(\.dismiss) private var dismiss

    @State private var loginId: String
    @State private var dept: String
    @State private var team: String
    @State private var role: String
    @State private var jobGroup: String
    @State private var rank: String
    @State private var rankYear: Int
    @State private var position: String
    @State private var salaryText: String
    @State private var email: String
    @State private var phone: String
    @State private var address: String
    @State private var isSaving = false
    @State private var errorMessage: String?

    private var client: APIClient { APIClient(settings: settings) }

    init(store: HRDataStore, employeeId: Int, onSaved: @escaping () -> Void) {
        self.store = store
        self.employeeId = employeeId
        self.onSaved = onSaved
        let raw = store.rawEmployeeDict(id: employeeId) ?? [:]
        _loginId = State(initialValue: raw["loginId"] as? String ?? "")
        _dept = State(initialValue: raw["dept"] as? String ?? "")
        _team = State(initialValue: raw["team"] as? String ?? "")
        _role = State(initialValue: raw["role"] as? String ?? "member")
        _jobGroup = State(initialValue: raw["jobGroup"] as? String ?? "")
        _rank = State(initialValue: raw["rank"] as? String ?? "")
        _rankYear = State(initialValue: raw["rankYear"] as? Int ?? 1)
        _position = State(initialValue: raw["position"] as? String ?? "")
        let salaryValue = raw["salary"] as? Int ?? 0
        _salaryText = State(initialValue: salaryValue > 0 ? String(salaryValue) : "")
        _email = State(initialValue: raw["email"] as? String ?? "")
        _phone = State(initialValue: raw["phone"] as? String ?? "")
        _address = State(initialValue: raw["address"] as? String ?? "")
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("계정") {
                    TextField("로그인ID", text: $loginId)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                }
                Section("조직") {
                    TextField("부서", text: $dept)
                    TextField("팀", text: $team)
                    Picker("역할", selection: $role) {
                        ForEach(employeeRoles, id: \.self) { Text(employeeRoleLabels[$0] ?? $0).tag($0) }
                    }
                }
                Section("직급 / 직책") {
                    TextField("직군", text: $jobGroup)
                    TextField("직급", text: $rank)
                    Stepper("직급 연차: \(rankYear)", value: $rankYear, in: 1...30)
                    TextField("직책", text: $position)
                }
                Section("연봉") {
                    TextField("연봉(원)", text: $salaryText).keyboardType(.numberPad)
                }
                Section("연락처") {
                    TextField("이메일", text: $email).keyboardType(.emailAddress)
                    TextField("전화번호", text: $phone).keyboardType(.phonePad)
                    TextField("주소", text: $address)
                }
                if let errorMessage {
                    Section { Text(errorMessage).font(.footnote).foregroundStyle(.red) }
                }
            }
            .navigationTitle("정보 수정")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("취소") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("저장") { Task { await submit() } }
                        .disabled(isSaving)
                }
            }
        }
    }

    private func submit() async {
        let trimmedLoginId = loginId.trimmingCharacters(in: .whitespaces)
        guard !trimmedLoginId.isEmpty else {
            errorMessage = "로그인ID는 비워둘 수 없습니다."
            return
        }
        guard !store.employees.contains(where: { $0.loginId == trimmedLoginId && $0.id != employeeId }) else {
            errorMessage = "이미 사용 중인 로그인ID입니다."
            return
        }
        isSaving = true
        defer { isSaving = false }

        let raw = store.rawEmployeeDict(id: employeeId) ?? [:]
        let changes: [String: Any] = [
            "loginId": trimmedLoginId, "dept": dept, "team": team, "role": role, "jobGroup": jobGroup,
            "rank": rank, "rankYear": rankYear, "position": position,
            "salary": Int(salaryText) ?? 0, "email": email, "phone": phone, "address": address,
        ]

        var diffs: [String] = []
        for (key, newValue) in changes {
            let oldStr = raw[key].map { "\($0)" } ?? ""
            let newStr = "\(newValue)"
            if oldStr != newStr {
                let label = editableFieldLabels[key] ?? key
                diffs.append("\(label): \(oldStr.isEmpty ? "-" : oldStr) → \(newStr.isEmpty ? "-" : newStr)")
            }
        }
        guard !diffs.isEmpty else {
            dismiss()
            return
        }

        store.updateEmployee(
            id: employeeId, changes: changes,
            historyDesc: (before: "-", after: diffs.joined(separator: ", "), desc: "관리자 정보 수정")
        )

        let saved = await store.save(client: client, session: session)
        if saved {
            onSaved()
            dismiss()
        } else {
            errorMessage = store.lastError ?? "저장에 실패했습니다."
        }
    }
}

/// index.html의 openRetireModal()/submitRetire()를 그대로 옮겼다 — 퇴직 처리 시 로그인이
/// 막히고(active:false), 대기중인 경비청구는 자동 반려된다(HRDataStore.retireEmployee 참고).
@MainActor
private struct RetireEmployeeView: View {
    @EnvironmentObject private var settings: AppSettings
    @EnvironmentObject private var session: SessionStore
    @ObservedObject var store: HRDataStore
    let employee: Employee
    let onSaved: () -> Void
    @Environment(\.dismiss) private var dismiss

    @State private var date = Date()
    @State private var reason = ""
    @State private var note = ""
    @State private var isSaving = false
    @State private var errorMessage: String?

    private let retireReasons = ["자진 퇴사", "권고 사직", "계약 만료", "정년 퇴직", "기타"]
    private var client: APIClient { APIClient(settings: settings) }
    private var dateFormatter: DateFormatter {
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; return f
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("⚠ 퇴직 처리 후에는 해당 직원이 로그인할 수 없습니다.")
                        .font(.footnote)
                        .foregroundStyle(AppTheme.danger)
                }
                Section("퇴직 정보") {
                    DatePicker("퇴직일 *", selection: $date, displayedComponents: .date)
                    Picker("퇴직 사유 *", selection: $reason) {
                        Text("선택").tag("")
                        ForEach(retireReasons, id: \.self) { Text($0).tag($0) }
                    }
                    TextField("비고", text: $note, axis: .vertical)
                }
                if let errorMessage {
                    Section { Text(errorMessage).font(.footnote).foregroundStyle(.red) }
                }
            }
            .navigationTitle("\(employee.name) 퇴직 처리")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("취소") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("퇴직 처리") { Task { await submit() } }
                        .disabled(isSaving || reason.isEmpty)
                }
            }
        }
    }

    private func submit() async {
        guard !reason.isEmpty else { return }
        isSaving = true
        defer { isSaving = false }
        store.retireEmployee(id: employee.id, date: dateFormatter.string(from: date), reason: reason, note: note)
        let saved = await store.save(client: client, session: session)
        if saved {
            onSaved()
            dismiss()
        } else {
            errorMessage = store.lastError ?? "저장에 실패했습니다."
        }
    }
}

/// index.html의 "비밀번호 초기화"(resetPassword())를 옮겼다 — 6자 이상 검증만 클라이언트에서
/// 하고 서버 쪽 최소 길이 검증은 없다. `updatedAt`을 반드시 갱신해야 한다는 게 중요한데
/// (웹 코드 주석에 남아있는 실측 버그 기록: updatedAt을 안 갱신하면 서버의 "동일 타임스탬프면
/// 재해싱 생략" 최적화에 걸려 화면엔 성공으로 뜨지만 실제로는 비밀번호가 안 바뀜),
/// `HRDataStore.updateEmployee()`가 항상 updatedAt을 갱신하므로 별도 처리가 필요 없다.
@MainActor
private struct ResetPasswordView: View {
    @EnvironmentObject private var settings: AppSettings
    @EnvironmentObject private var session: SessionStore
    @ObservedObject var store: HRDataStore
    let employee: Employee
    let onSaved: () -> Void
    @Environment(\.dismiss) private var dismiss

    @State private var newPassword = ""
    @State private var isSaving = false
    @State private var errorMessage: String?

    private var client: APIClient { APIClient(settings: settings) }

    var body: some View {
        NavigationStack {
            Form {
                Section("\(employee.name) 비밀번호 재설정") {
                    SecureField("새 비밀번호 (6자 이상)", text: $newPassword)
                }
                if let errorMessage {
                    Section { Text(errorMessage).font(.footnote).foregroundStyle(.red) }
                }
            }
            .navigationTitle("비밀번호 재설정")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("취소") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("초기화") { Task { await submit() } }
                        .disabled(isSaving || newPassword.count < 6)
                }
            }
        }
    }

    private func submit() async {
        guard newPassword.count >= 6 else {
            errorMessage = "비밀번호는 6자 이상이어야 합니다."
            return
        }
        isSaving = true
        defer { isSaving = false }
        store.updateEmployee(id: employee.id, changes: ["pw": newPassword], historyDesc: nil)
        let saved = await store.save(client: client, session: session)
        if saved {
            onSaved()
            dismiss()
        } else {
            errorMessage = store.lastError ?? "저장에 실패했습니다."
        }
    }
}

private let hrChangeTypeLabels: [(key: String, label: String)] = [
    ("transfer", "조직 발령"), ("salary", "연봉 변동"), ("promotion", "승진"),
    ("rank_change", "직급 변동"), ("position", "직책 임명"), ("other", "기타"),
]

/// index.html의 "발령·변동 이력" 등록(submitHRChange())을 옮겼다 — 실제 필드가 바뀌는
/// 유형(전보/연봉/승진/직급변동/직책)만 유형별 전용 입력을 제공하고, 나머지(포상·핵심인재·
/// 휴직·복직·교육 등)는 웹과 동일하게 "기타"로 묶어 자유 텍스트(변동 전/후)만 기록한다.
/// 퇴직은 대기중인 경비청구 자동 반려 등 부가 효과가 있는 "퇴직 처리"(RetireEmployeeView)를
/// 그대로 쓴다 — 이 화면의 선택지에는 없다.
@MainActor
private struct HRChangeView: View {
    @EnvironmentObject private var settings: AppSettings
    @EnvironmentObject private var session: SessionStore
    @ObservedObject var store: HRDataStore
    let employee: Employee
    let onSaved: () -> Void
    @Environment(\.dismiss) private var dismiss

    @State private var type = "transfer"
    @State private var date = Date()
    @State private var desc = ""
    @State private var note = ""
    @State private var newDept = ""
    @State private var newTeam = ""
    @State private var newSalaryText = ""
    @State private var newRank = ""
    @State private var newPosition = ""
    @State private var otherBefore = ""
    @State private var otherAfter = ""
    @State private var isSaving = false
    @State private var errorMessage: String?

    private var client: APIClient { APIClient(settings: settings) }
    private var dateFormatter: DateFormatter {
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; return f
    }
    private var isFutureDate: Bool {
        dateFormatter.string(from: date) > dateFormatter.string(from: Date())
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("변동 정보") {
                    Picker("변동 유형", selection: $type) {
                        ForEach(hrChangeTypeLabels, id: \.key) { Text($0.label).tag($0.key) }
                    }
                    DatePicker("변동 일자 *", selection: $date, displayedComponents: .date)
                    TextField("변동 내용 *", text: $desc)
                }

                switch type {
                case "transfer":
                    Section("변동 후 부서/팀") {
                        TextField("부서", text: $newDept)
                        TextField("팀", text: $newTeam)
                    }
                case "salary":
                    Section("변동 후 연봉(원)") {
                        TextField("연봉", text: $newSalaryText).keyboardType(.numberPad)
                    }
                case "promotion", "rank_change":
                    Section("변동 후 직급") {
                        TextField("직급", text: $newRank)
                    }
                case "position":
                    Section("변동 후 직책") {
                        TextField("직책", text: $newPosition)
                    }
                default:
                    Section("변동 전/후") {
                        TextField("변동 전", text: $otherBefore)
                        TextField("변동 후", text: $otherAfter)
                    }
                }

                if isFutureDate && type != "other" {
                    Section {
                        Text("변동 일자가 미래라 지금은 이력에만 기록되고, 그 날짜가 되면 조직도 화면 진입 시 자동으로 실제 정보에 반영됩니다.")
                            .font(.caption)
                            .foregroundStyle(AppTheme.secondaryText)
                    }
                }

                Section("비고") {
                    TextField("비고 (선택)", text: $note, axis: .vertical)
                }
                if let errorMessage {
                    Section { Text(errorMessage).font(.footnote).foregroundStyle(.red) }
                }
            }
            .navigationTitle("발령·변동 이력 등록")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("취소") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("등록") { Task { await submit() } }
                        .disabled(isSaving || desc.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
    }

    private func submit() async {
        let desc = self.desc.trimmingCharacters(in: .whitespaces)
        guard !desc.isEmpty else { return }
        isSaving = true
        defer { isSaving = false }

        var updates: [String: Any] = [:]
        var before = ""
        var after = ""
        switch type {
        case "transfer":
            guard !newDept.trimmingCharacters(in: .whitespaces).isEmpty else {
                errorMessage = "변동 후 부서를 입력하세요."
                return
            }
            before = [employee.dept, employee.team].compactMap { $0 }.joined(separator: "/")
            after = [newDept, newTeam].joined(separator: "/")
            updates = ["dept": newDept, "team": newTeam]
        case "salary":
            guard let salary = Int(newSalaryText), salary > 0 else {
                errorMessage = "변동 후 연봉을 입력하세요."
                return
            }
            before = "-"
            after = "\(salary)원"
            updates = ["salary": salary]
        case "promotion", "rank_change":
            guard !newRank.trimmingCharacters(in: .whitespaces).isEmpty else {
                errorMessage = "변동 후 직급을 입력하세요."
                return
            }
            before = employee.rank ?? "-"
            after = newRank
            updates = ["rank": newRank]
        case "position":
            guard !newPosition.trimmingCharacters(in: .whitespaces).isEmpty else {
                errorMessage = "변동 후 직책을 입력하세요."
                return
            }
            before = employee.position ?? "-"
            after = newPosition
            updates = ["position": newPosition]
        default:
            before = otherBefore
            after = otherAfter
        }

        guard store.appendHRChange(
            employeeId: employee.id, type: type, date: dateFormatter.string(from: date),
            desc: desc, before: before, after: after, note: note, updates: updates
        ) else {
            errorMessage = "저장 대상을 찾을 수 없습니다."
            return
        }

        let saved = await store.save(client: client, session: session)
        if saved {
            onSaved()
            dismiss()
        } else {
            errorMessage = store.lastError ?? "저장에 실패했습니다."
        }
    }
}
