import SwiftUI

@MainActor
struct EmployeeDirectoryView: View {
    @EnvironmentObject private var settings: AppSettings
    @EnvironmentObject private var session: SessionStore
    @ObservedObject var store: HRDataStore
    let reload: () async -> Void

    @State private var query = ""
    @State private var showingNewEmployee = false

    private var isAdmin: Bool { session.currentEmployee?.role == "admin" }

    private var filtered: [Employee] {
        // 관리자는 퇴사자도 관리 대상이라 그대로 보여주고, 일반 사용자에게는 조직도
        // 취지에 맞게 재직자만 노출한다.
        let base = isAdmin ? store.employees : store.employees.filter { $0.active != false }
        guard !query.trimmingCharacters(in: .whitespaces).isEmpty else {
            return base.sorted { $0.name < $1.name }
        }
        return base
            .filter {
                $0.name.localizedCaseInsensitiveContains(query)
                    || ($0.dept?.localizedCaseInsensitiveContains(query) ?? false)
                    || ($0.team?.localizedCaseInsensitiveContains(query) ?? false)
            }
            .sorted { $0.name < $1.name }
    }

    var body: some View {
        AppScreen {
            if filtered.isEmpty {
                EmptyState(message: "검색 결과가 없습니다.")
            }
            ForEach(filtered) { employee in
                NavigationLink {
                    EmployeeDetailView(employeeId: employee.id, store: store, reload: reload)
                } label: {
                    AppCard {
                        HStack(spacing: 12) {
                            ZStack {
                                Circle().fill(AppTheme.accentLight).frame(width: 36, height: 36)
                                Text(String(employee.name.prefix(1)))
                                    .font(.caption.weight(.bold))
                                    .foregroundStyle(AppTheme.accentDark)
                            }
                            VStack(alignment: .leading, spacing: 2) {
                                HStack(spacing: 6) {
                                    Text(employee.name).font(.subheadline.weight(.semibold))
                                    if employee.active == false {
                                        Text("퇴사").font(.caption2.weight(.semibold))
                                            .foregroundStyle(AppTheme.secondaryText)
                                    }
                                }
                                Text([employee.dept, employee.team, employee.position]
                                    .compactMap { $0 }
                                    .filter { !$0.isEmpty }
                                    .joined(separator: " · "))
                                    .font(.caption)
                                    .foregroundStyle(AppTheme.secondaryText)
                            }
                            Spacer()
                            Image(systemName: "chevron.right")
                                .font(.caption)
                                .foregroundStyle(AppTheme.secondaryText)
                        }
                    }
                }
                .buttonStyle(.plain)
            }
        }
        .searchable(text: $query, prompt: "이름·부서·팀 검색")
        .navigationTitle("조직도 (\(filtered.count)명)")
        .refreshable { await reload() }
        .toolbar {
            if isAdmin {
                ToolbarItem(placement: .primaryAction) {
                    Button { showingNewEmployee = true } label: {
                        Image(systemName: "person.badge.plus")
                    }
                }
            }
        }
        .sheet(isPresented: $showingNewEmployee) {
            NewEmployeeView(store: store) {
                Task { await reload() }
            }
            .environmentObject(settings)
            .environmentObject(session)
        }
    }
}

let employeeRoles = ["member", "leader", "director", "admin"]
let employeeRoleLabels = ["member": "팀원", "leader": "팀장", "director": "임원", "admin": "관리자"]

/// index.html의 신규 직원 등록(submitHRForm)을 옮겼다 — 필수: 이름/사번/입사일/부서
/// (director는 팀 없이 본부 단위 소속이 흔해 팀만 예외적으로 선택), 사번·로그인ID 중복은
/// 서버가 아니라 클라이언트에서 먼저 막는다(서버도 저장 시 중복이면 `warnings.duplicateLoginIds`로
/// 알려주지만 막지는 않음). id는 반드시 서버 원자적 발급(next-id)으로 받는다.
@MainActor
private struct NewEmployeeView: View {
    @EnvironmentObject private var settings: AppSettings
    @EnvironmentObject private var session: SessionStore
    @ObservedObject var store: HRDataStore
    let onSaved: () -> Void
    @Environment(\.dismiss) private var dismiss

    @State private var name = ""
    @State private var empNo = ""
    @State private var role = "member"
    @State private var dept = ""
    @State private var team = ""
    @State private var loginId = ""
    @State private var password = ""
    @State private var hireDate = Date()
    @State private var birthDate = Date()
    @State private var gender = "남"
    @State private var jobGroup = ""
    @State private var rank = ""
    @State private var rankYear = 1
    @State private var totalCareer = 0
    @State private var salaryText = ""
    @State private var position = ""
    @State private var email = ""
    @State private var phone = ""
    @State private var address = ""
    @State private var edu = "대학교 졸업"
    @State private var eduSchool = ""
    @State private var isSaving = false
    @State private var errorMessage: String?

    private var client: APIClient { APIClient(settings: settings) }
    private var isDirector: Bool { role == "director" }
    private var dateFormatter: DateFormatter {
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; return f
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("기본 정보") {
                    TextField("이름 *", text: $name)
                    TextField("사번 *", text: $empNo)
                    Picker("역할", selection: $role) {
                        ForEach(employeeRoles, id: \.self) { Text(employeeRoleLabels[$0] ?? $0).tag($0) }
                    }
                    TextField("부서 *", text: $dept)
                    TextField(isDirector ? "팀 (선택)" : "팀 *", text: $team)
                }
                Section("계정") {
                    TextField("로그인ID (미입력 시 사번)", text: $loginId)
                    SecureField("초기 비밀번호 (미입력 시 사번)", text: $password)
                }
                Section("인사 정보") {
                    DatePicker("입사일 *", selection: $hireDate, displayedComponents: .date)
                    DatePicker("생년월일", selection: $birthDate, displayedComponents: .date)
                    Picker("성별", selection: $gender) {
                        Text("남").tag("남"); Text("여").tag("여")
                    }
                    TextField("직군", text: $jobGroup)
                    TextField("직급", text: $rank)
                    Stepper("직급 연차: \(rankYear)", value: $rankYear, in: 1...30)
                    Stepper("총 경력(년): \(totalCareer)", value: $totalCareer, in: 0...50)
                }
                Section("직책 / 연봉") {
                    TextField("직책", text: $position)
                    TextField("연봉(원)", text: $salaryText).keyboardType(.numberPad)
                }
                Section("연락처") {
                    TextField("이메일", text: $email).keyboardType(.emailAddress)
                    TextField("전화번호", text: $phone).keyboardType(.phonePad)
                    TextField("주소", text: $address)
                }
                Section("학력") {
                    TextField("최종학력", text: $edu)
                    TextField("출신학교", text: $eduSchool)
                }
                if let errorMessage {
                    Section { Text(errorMessage).font(.footnote).foregroundStyle(.red) }
                }
            }
            .navigationTitle("신규 직원 등록")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("취소") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("등록") { Task { await submit() } }
                        .disabled(isSaving)
                }
            }
        }
    }

    private func submit() async {
        let trimmedEmpNo = empNo.trimmingCharacters(in: .whitespaces)
        guard !name.trimmingCharacters(in: .whitespaces).isEmpty, !trimmedEmpNo.isEmpty,
              !dept.trimmingCharacters(in: .whitespaces).isEmpty,
              isDirector || !team.trimmingCharacters(in: .whitespaces).isEmpty else {
            errorMessage = "필수 항목(이름/사번/부서" + (isDirector ? "" : "/팀") + ")을 모두 입력하세요."
            return
        }
        let resolvedLoginId = loginId.trimmingCharacters(in: .whitespaces).isEmpty ? trimmedEmpNo : loginId
        guard !store.employees.contains(where: { $0.empNo == trimmedEmpNo || $0.loginId == resolvedLoginId }) else {
            errorMessage = "사번 또는 로그인ID가 이미 사용 중입니다."
            return
        }
        guard let token = session.token else { return }
        isSaving = true
        defer { isSaving = false }

        let newId: Int
        do {
            newId = try await client.nextEmployeeId(token: token)
        } catch {
            if case APIError.serverError(401, _) = error {
                session.handleUnauthorized()
            } else {
                errorMessage = "id 발급 실패: \(error.localizedDescription)"
            }
            return
        }

        let nowISO = ISO8601DateFormatter().string(from: Date())
        let payload = NewEmployeePayload(
            id: newId, loginId: resolvedLoginId,
            pw: password.isEmpty ? trimmedEmpNo : password,
            name: name, empNo: trimmedEmpNo, role: role, dept: dept, team: team,
            birth: dateFormatter.string(from: birthDate), gender: gender,
            hire: dateFormatter.string(from: hireDate), jobGroup: jobGroup, rank: rank,
            rankYear: rankYear, salary: Int(salaryText) ?? 0, edu: edu, eduSchool: eduSchool,
            totalCareer: totalCareer, position: position, email: email, phone: phone, address: address,
            active: true, retireDate: "", retireReason: "",
            customFields: [:], careers: [], hrHistory: [], updatedAt: nowISO
        )

        do {
            try store.createEmployee(payload)
        } catch {
            errorMessage = error.localizedDescription
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
