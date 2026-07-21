import SwiftUI

/// index.html의 "KPI 승인 현황"/"1차 평가 입력"/"2차 평가 입력" 탭(renderApprovalList/
/// renderEvalTab)을 옮겼다 — 팀장(leader)이 팀원의 KPI 목표를 1차 승인하고 1차 점수를,
/// 사업부장(director)이 2차 점수와 최종 확정을 입력하는 평가자 워크플로. admin은 전체
/// 범위에서 두 역할을 다 수행할 수 있다(웹과 동일).
///
/// 담당 범위(scope)는 웹의 renderApprovals()와 동일한 규칙: admin=전체, director=같은 부서,
/// leader=같은 부서+팀. 동점자 처리·수정요청 승인·부서별 자동 등급 산정은 범위 밖(README 참고).
@MainActor
struct KPIApprovalView: View {
    @EnvironmentObject private var settings: AppSettings
    @EnvironmentObject private var session: SessionStore
    @ObservedObject var store: HRDataStore
    let reload: () async -> Void

    @State private var year = Calendar.current.component(.year, from: Date())
    @State private var rejectTarget: (entry: KPIEntry, stage: String)?
    @State private var finalizeTarget: KPIEntry?
    @State private var firstEvalTarget: (employee: Employee, entries: [KPIEntry])?
    @State private var secondEvalTarget: (employee: Employee, entries: [KPIEntry])?
    @State private var errorMessage: String?

    private var client: APIClient { APIClient(settings: settings) }
    private var myRole: String? { session.currentEmployee?.role }
    private var isLeaderOrAdmin: Bool { myRole == "leader" || myRole == "admin" }
    private var isDirectorOrAdmin: Bool { myRole == "director" || myRole == "admin" }

    private var scopeEmployees: [Employee] {
        guard let me = session.currentEmployee else { return [] }
        switch me.role {
        case "admin":
            return store.employees.filter { $0.active != false && $0.id != me.id }
        case "director":
            return store.employees.filter { $0.active != false && $0.dept == me.dept && $0.id != me.id }
        case "leader":
            return store.employees.filter { $0.active != false && $0.dept == me.dept && $0.team == me.team && $0.id != me.id }
        default:
            return []
        }
    }

    private func entries(for employee: Employee) -> [KPIEntry] {
        store.kpiEntries.filter { $0.userId == employee.id && $0.year == year && ($0.goalSub ?? 0) == 1 }
            .sorted { $0.item < $1.item }
    }

    var body: some View {
        AppScreen {
            if let errorMessage {
                AppCard { Text(errorMessage).font(.footnote).foregroundStyle(AppTheme.danger) }
            }
            let people = scopeEmployees.filter { !entries(for: $0).isEmpty }
            if people.isEmpty {
                EmptyState(message: "\(year)년 제출된 KPI 목표가 없습니다.")
            }
            ForEach(people) { employee in
                employeeCard(employee)
            }
        }
        .navigationTitle("KPI 평가 관리 (\(year)년)")
        .refreshable { await reload() }
        .sheet(item: Binding(
            get: { rejectTarget.map { RejectWrapper(entry: $0.entry, stage: $0.stage) } },
            set: { if $0 == nil { rejectTarget = nil } }
        )) { wrapper in
            KPIRejectView(store: store, entry: wrapper.entry, stage: wrapper.stage) {
                Task { await reload() }
            }
            .environmentObject(settings)
            .environmentObject(session)
        }
        .sheet(item: $finalizeTarget) { entry in
            KPIFinalizeView(store: store, entry: entry) {
                Task { await reload() }
            }
            .environmentObject(settings)
            .environmentObject(session)
        }
        .sheet(item: Binding(
            get: { firstEvalTarget.map { BatchWrapper(employee: $0.employee, entries: $0.entries, stage: "first") } },
            set: { if $0 == nil { firstEvalTarget = nil } }
        )) { wrapper in
            KPIBatchEvalView(store: store, employee: wrapper.employee, entries: wrapper.entries, stage: wrapper.stage, year: year) {
                Task { await reload() }
            }
            .environmentObject(settings)
            .environmentObject(session)
        }
        .sheet(item: Binding(
            get: { secondEvalTarget.map { BatchWrapper(employee: $0.employee, entries: $0.entries, stage: "second") } },
            set: { if $0 == nil { secondEvalTarget = nil } }
        )) { wrapper in
            KPIBatchEvalView(store: store, employee: wrapper.employee, entries: wrapper.entries, stage: wrapper.stage, year: year) {
                Task { await reload() }
            }
            .environmentObject(settings)
            .environmentObject(session)
        }
    }

    @ViewBuilder
    private func employeeCard(_ employee: Employee) -> some View {
        let empEntries = entries(for: employee)
        let firstApprovedEntries = empEntries.filter { $0.firstStatus == "approved" }

        AppCard(title: "\(employee.name) · \(employee.dept ?? "") \(employee.team ?? "")") {
            ForEach(empEntries) { entry in
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Text(entry.item).font(.subheadline.weight(.semibold))
                        Spacer()
                        Text("\(Int(entry.weight ?? 0))%").font(.caption).foregroundStyle(AppTheme.secondaryText)
                    }
                    HStack(spacing: 14) {
                        scoreLabel("자기", entry.selfScore)
                        scoreLabel("1차", entry.firstScore)
                        scoreLabel("2차", entry.secondScore)
                        scoreLabel("최종", entry.finalScore)
                        Spacer()
                    }
                    entryActions(employee: employee, entry: entry)
                }
                .padding(.vertical, 4)
                if entry.id != empEntries.last?.id { Divider() }
            }

            HStack(spacing: 10) {
                if isLeaderOrAdmin && !firstApprovedEntries.isEmpty {
                    Button("1차 평가 입력") { firstEvalTarget = (employee, firstApprovedEntries) }
                        .buttonStyle(.bordered).tint(AppTheme.accent)
                }
                if isDirectorOrAdmin && !firstApprovedEntries.isEmpty {
                    Button("2차 평가 입력") { secondEvalTarget = (employee, firstApprovedEntries) }
                        .buttonStyle(.bordered).tint(AppTheme.accentDark)
                }
            }
            .padding(.top, 4)
        }
    }

    @ViewBuilder
    private func entryActions(employee: Employee, entry: KPIEntry) -> some View {
        let ownerIsMember = employee.role == "member" || employee.role == nil
        if ownerIsMember && entry.firstStatus == nil && isLeaderOrAdmin {
            HStack(spacing: 8) {
                Button("1차 승인") { approveFirst(entry) }.buttonStyle(.bordered).tint(AppTheme.accent).controlSize(.small)
                Button("반려") { rejectTarget = (entry, "first") }.buttonStyle(.bordered).tint(AppTheme.danger).controlSize(.small)
            }
        } else if ownerIsMember && entry.firstStatus == "approved" && entry.finalStatus == nil && isDirectorOrAdmin {
            HStack(spacing: 8) {
                Button("최종 확정") { finalizeTarget = entry }.buttonStyle(.bordered).tint(AppTheme.accentDark).controlSize(.small)
                Button("반려") { rejectTarget = (entry, "final") }.buttonStyle(.bordered).tint(AppTheme.danger).controlSize(.small)
            }
        } else if !ownerIsMember && entry.finalStatus == nil && isDirectorOrAdmin {
            HStack(spacing: 8) {
                Button("최종 확정") { finalizeTarget = entry }.buttonStyle(.bordered).tint(AppTheme.accentDark).controlSize(.small)
                Button("반려") { rejectTarget = (entry, "final") }.buttonStyle(.bordered).tint(AppTheme.danger).controlSize(.small)
            }
        } else {
            StatusPill(status: entry.finalStatus == "approved" ? "approved" : (entry.firstStatus == "rejected" || entry.finalStatus == "rejected" ? "rejected" : "in_progress"))
        }
    }

    @ViewBuilder
    private func scoreLabel(_ label: String, _ score: Double?) -> some View {
        VStack(spacing: 2) {
            Text(label).font(.caption2).foregroundStyle(AppTheme.secondaryText)
            Text(score.map { String(format: "%.1f", $0) } ?? "-").font(.caption.weight(.semibold))
        }
    }

    private func approveFirst(_ entry: KPIEntry) {
        guard store.approveKPIFirst(id: entry.id) else { return }
        Task {
            let saved = await store.save(client: client, session: session)
            if !saved { errorMessage = store.lastError ?? "저장에 실패했습니다." }
        }
    }
}

private struct RejectWrapper: Identifiable {
    let entry: KPIEntry
    let stage: String
    var id: Int { entry.id }
}

private struct BatchWrapper: Identifiable {
    let employee: Employee
    let entries: [KPIEntry]
    let stage: String
    var id: Int { employee.id }
}

@MainActor
private struct KPIRejectView: View {
    @EnvironmentObject private var settings: AppSettings
    @EnvironmentObject private var session: SessionStore
    @ObservedObject var store: HRDataStore
    let entry: KPIEntry
    let stage: String
    let onSaved: () -> Void
    @Environment(\.dismiss) private var dismiss

    @State private var reason = ""
    @State private var isSaving = false
    @State private var errorMessage: String?

    private var client: APIClient { APIClient(settings: settings) }

    var body: some View {
        NavigationStack {
            Form {
                Section(entry.item) {
                    TextField("반려 사유 *", text: $reason, axis: .vertical)
                }
                if let errorMessage {
                    Section { Text(errorMessage).font(.footnote).foregroundStyle(.red) }
                }
            }
            .navigationTitle("반려 사유 입력")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("취소") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("반려 처리") { Task { await submit() } }
                        .disabled(isSaving || reason.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
    }

    private func submit() async {
        isSaving = true
        defer { isSaving = false }
        guard store.rejectKPI(id: entry.id, stage: stage, reason: reason) else { return }
        let saved = await store.save(client: client, session: session)
        if saved {
            onSaved()
            dismiss()
        } else {
            errorMessage = store.lastError ?? "저장에 실패했습니다."
        }
    }
}

@MainActor
private struct KPIFinalizeView: View {
    @EnvironmentObject private var settings: AppSettings
    @EnvironmentObject private var session: SessionStore
    @ObservedObject var store: HRDataStore
    let entry: KPIEntry
    let onSaved: () -> Void
    @Environment(\.dismiss) private var dismiss

    @State private var scoreText: String
    @State private var isSaving = false
    @State private var errorMessage: String?

    private var client: APIClient { APIClient(settings: settings) }

    init(store: HRDataStore, entry: KPIEntry, onSaved: @escaping () -> Void) {
        self.store = store
        self.entry = entry
        self.onSaved = onSaved
        let defaultScore = entry.secondScore ?? entry.firstScore ?? entry.selfScore
        _scoreText = State(initialValue: defaultScore.map { String(Int($0)) } ?? "")
    }

    var body: some View {
        NavigationStack {
            Form {
                Section(entry.item) {
                    LabeledContent("자체", value: entry.selfScore.map { "\(Int($0))점" } ?? "-")
                    LabeledContent("1차", value: entry.firstScore.map { "\(Int($0))점" } ?? "-")
                    LabeledContent("2차", value: entry.secondScore.map { "\(Int($0))점" } ?? "-")
                }
                Section("최종 확정 점수 (0~100)") {
                    TextField("점수 *", text: $scoreText).keyboardType(.numberPad)
                }
                if let errorMessage {
                    Section { Text(errorMessage).font(.footnote).foregroundStyle(.red) }
                }
            }
            .navigationTitle("최종 확정")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("취소") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("최종 확정") { Task { await submit() } }
                        .disabled(isSaving || Double(scoreText) == nil)
                }
            }
        }
    }

    private func submit() async {
        guard let score = Double(scoreText) else { return }
        isSaving = true
        defer { isSaving = false }
        guard store.finalizeKPI(id: entry.id, finalScore: score) else { return }
        let saved = await store.save(client: client, session: session)
        if saved {
            onSaved()
            dismiss()
        } else {
            errorMessage = store.lastError ?? "저장에 실패했습니다."
        }
    }
}

/// index.html의 openFirstEvalModal()/saveFirstEval() 및 openSecondEvalModal()/
/// saveSecondEval()을 하나로 합쳤다(둘 다 "팀원 한 명의 여러 KPI 항목에 점수+공통 의견을
/// 한 번에 저장" 구조가 동일). `stage`가 "first"면 1차, "second"면 2차.
@MainActor
private struct KPIBatchEvalView: View {
    @EnvironmentObject private var settings: AppSettings
    @EnvironmentObject private var session: SessionStore
    @ObservedObject var store: HRDataStore
    let employee: Employee
    let entries: [KPIEntry]
    let stage: String
    let year: Int
    let onSaved: () -> Void
    @Environment(\.dismiss) private var dismiss

    @State private var scoreTexts: [Int: String]
    @State private var comment = ""
    @State private var isPublic = false
    @State private var isSaving = false
    @State private var errorMessage: String?

    private var client: APIClient { APIClient(settings: settings) }
    private var isFirst: Bool { stage == "first" }

    init(store: HRDataStore, employee: Employee, entries: [KPIEntry], stage: String, year: Int, onSaved: @escaping () -> Void) {
        self.store = store
        self.employee = employee
        self.entries = entries
        self.stage = stage
        self.year = year
        self.onSaved = onSaved
        var initial: [Int: String] = [:]
        for entry in entries {
            let existing = stage == "first" ? entry.firstScore : (entry.secondScore ?? entry.firstScore)
            initial[entry.id] = existing.map { String(Int($0)) } ?? ""
        }
        _scoreTexts = State(initialValue: initial)
    }

    var body: some View {
        NavigationStack {
            Form {
                ForEach(entries) { entry in
                    Section(entry.item) {
                        LabeledContent("비중", value: "\(Int(entry.weight ?? 0))%")
                        if let goal = entry.goal, !goal.isEmpty {
                            LabeledContent("목표", value: goal)
                        }
                        LabeledContent("자체점수", value: entry.selfScore.map { "\(Int($0))점" } ?? "-")
                        if !isFirst {
                            LabeledContent("1차점수", value: entry.firstScore.map { "\(Int($0))점" } ?? "-")
                        }
                        TextField(
                            "\(isFirst ? "1차" : "2차") 평가 점수 (0~100) *",
                            text: Binding(
                                get: { scoreTexts[entry.id] ?? "" },
                                set: { scoreTexts[entry.id] = $0 }
                            )
                        )
                        .keyboardType(.numberPad)
                    }
                }
                Section("전체 종합 평가 의견 (필수, \(isFirst ? "2차 평가자에게 공개" : "본인 공개 여부 선택 가능"))") {
                    TextField("종합 의견 *", text: $comment, axis: .vertical)
                    if !isFirst {
                        Toggle("본인에게 공개", isOn: $isPublic)
                    }
                }
                if let errorMessage {
                    Section { Text(errorMessage).font(.footnote).foregroundStyle(.red) }
                }
            }
            .navigationTitle("\(isFirst ? "1차" : "2차") 평가 — \(employee.name)")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("취소") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("저장") { Task { await submit() } }
                        .disabled(isSaving || !isValid)
                }
            }
        }
    }

    private var isValid: Bool {
        guard !comment.trimmingCharacters(in: .whitespaces).isEmpty else { return false }
        return entries.allSatisfy { Double(scoreTexts[$0.id] ?? "") != nil }
    }

    private func submit() async {
        guard isValid else { return }
        isSaving = true
        defer { isSaving = false }
        var scores: [Int: Double] = [:]
        for entry in entries {
            guard let score = Double(scoreTexts[entry.id] ?? "") else { return }
            scores[entry.id] = score
        }
        let changed: Bool
        if isFirst {
            changed = store.saveKPIFirstEval(userId: employee.id, year: year, scores: scores, comment: comment)
        } else {
            changed = store.saveKPISecondEval(userId: employee.id, year: year, scores: scores, comment: comment, isPublic: isPublic)
        }
        guard changed else {
            errorMessage = "저장할 항목이 없습니다."
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
