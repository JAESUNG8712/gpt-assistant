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
    "dept": "부서", "team": "팀", "role": "역할", "jobGroup": "직군", "rank": "직급",
    "rankYear": "직급연차", "position": "직책", "salary": "연봉", "email": "이메일",
    "phone": "전화번호", "address": "주소",
]

/// index.html의 "발령·변동 이력"(submitHRChange)을 간략화해서 옮겼다 — 웹은 전보/연봉/승진/
/// 직책/휴직 등 유형별로 별도 폼과 미래 날짜 예약 적용까지 지원하지만, 이 앱은 변경 즉시
/// 적용되는 단일 폼으로 통합하고 바뀐 필드만 모아 hrHistory에 감사 기록 한 건을 남긴다
/// (유형별 예약 적용은 범위 밖).
@MainActor
private struct EditEmployeeView: View {
    @EnvironmentObject private var settings: AppSettings
    @EnvironmentObject private var session: SessionStore
    @ObservedObject var store: HRDataStore
    let employeeId: Int
    let onSaved: () -> Void
    @Environment(\.dismiss) private var dismiss

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
        isSaving = true
        defer { isSaving = false }

        let raw = store.rawEmployeeDict(id: employeeId) ?? [:]
        let changes: [String: Any] = [
            "dept": dept, "team": team, "role": role, "jobGroup": jobGroup,
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
