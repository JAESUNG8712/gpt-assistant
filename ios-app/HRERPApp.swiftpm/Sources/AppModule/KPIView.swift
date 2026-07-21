import SwiftUI

/// kpiEntries(자기평가→1차→2차→최종확정 다면평가)는 GET /data 블롭의 일부라 근태·결재와
/// 같은 방식으로 읽고 쓴다. 본인의 목표 등록/제출과 자체평가(실적·자체점수) 입력은 이 화면에서
/// 지원한다. 1차/2차평가(팀장·사업부장이 팀원 여러 명의 KPI를 한 번에 배치 처리)·최종확정·
/// 등급조정 등 평가자·관리자 워크플로는 부서별 자동 등급 산정과도 얽혀 있어 범위 밖이다
/// (README "범위 밖" 참고) — 그 값들은 계속 읽기 전용으로만 보여준다.
@MainActor
struct KPIView: View {
    @EnvironmentObject private var settings: AppSettings
    @EnvironmentObject private var session: SessionStore
    @ObservedObject var store: HRDataStore
    let reload: () async -> Void

    @State private var showingNewGoal = false
    @State private var selectedEntry: KPIEntry?
    @State private var errorMessage: String?

    private var client: APIClient { APIClient(settings: settings) }
    private var currentYear: Int { Calendar.current.component(.year, from: Date()) }

    private var myEntries: [KPIEntry] {
        guard let empId = session.currentEmployee?.id else { return [] }
        return store.kpiEntries
            .filter { $0.userId == empId }
            .sorted { ($0.year ?? 0) > ($1.year ?? 0) }
    }

    private var entriesByYear: [(year: Int, entries: [KPIEntry])] {
        let groups = Dictionary(grouping: myEntries) { $0.year ?? 0 }
        return groups.keys.sorted(by: >).map { (year: $0, entries: groups[$0] ?? []) }
    }

    var body: some View {
        AppScreen {
            if let errorMessage {
                AppCard { Text(errorMessage).font(.footnote).foregroundStyle(AppTheme.danger) }
            }
            if myEntries.isEmpty {
                EmptyState(message: "등록된 평가 목표가 없습니다.")
            }
            ForEach(entriesByYear, id: \.year) { group in
                yearSection(year: group.year, entries: group.entries)
            }
        }
        .navigationTitle("평가 / KPI")
        .refreshable { await reload() }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { showingNewGoal = true } label: { Image(systemName: "plus") }
            }
        }
        .sheet(isPresented: $showingNewGoal) {
            NewKPIGoalView(store: store, year: currentYear) { Task { await reload() } }
                .environmentObject(settings)
                .environmentObject(session)
        }
        .sheet(item: $selectedEntry) { entry in
            KPISelfEvalView(store: store, entry: entry) { Task { await reload() } }
                .environmentObject(settings)
                .environmentObject(session)
        }
    }

    @ViewBuilder
    private func yearSection(year: Int, entries: [KPIEntry]) -> some View {
        let weightSum = entries.reduce(0.0) { $0 + ($1.weight ?? 0) }
        let hasDraft = entries.contains { ($0.goalSub ?? 0) != 1 }

        AppCard(title: "\(year)년 (비중 합계 \(Int(weightSum))%)") {
            ForEach(entries) { entry in
                HStack {
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text(entry.item).font(.subheadline.weight(.semibold))
                            if (entry.goalSub ?? 0) != 1 {
                                Text("초안").font(.caption2).foregroundStyle(AppTheme.warning)
                            }
                        }
                        if let goal = entry.goal, !goal.isEmpty {
                            Text(goal).font(.caption).foregroundStyle(AppTheme.secondaryText)
                        }
                        HStack(spacing: 16) {
                            scoreLabel("자기", entry.selfScore)
                            scoreLabel("1차", entry.firstScore)
                            scoreLabel("2차", entry.secondScore)
                            scoreLabel("최종", entry.finalScore)
                        }
                    }
                    Spacer()
                    if let weight = entry.weight {
                        Text("\(Int(weight))%").font(.caption.weight(.semibold)).foregroundStyle(AppTheme.secondaryText)
                    }
                }
                .contentShape(Rectangle())
                .onTapGesture { selectedEntry = entry }
                if entry.id != entries.last?.id { Divider() }
            }

            if hasDraft {
                Button("목표 제출 (비중 합계 100% 필요)") {
                    submitGoals(year: year, weightSum: weightSum)
                }
                .buttonStyle(.bordered)
                .tint(AppTheme.accent)
                .disabled(Int(weightSum) != 100)
                .padding(.top, 4)
            }
        }
    }

    @ViewBuilder
    private func scoreLabel(_ label: String, _ score: Double?) -> some View {
        VStack(spacing: 2) {
            Text(label).font(.caption2).foregroundStyle(AppTheme.secondaryText)
            Text(score.map { String(format: "%.1f", $0) } ?? "-").font(.caption.weight(.semibold))
        }
    }

    private func submitGoals(year: Int, weightSum: Double) {
        guard Int(weightSum) == 100, let empId = session.currentEmployee?.id else {
            errorMessage = "KPI 비중 합계가 100%가 되어야 제출할 수 있습니다. 현재: \(Int(weightSum))%"
            return
        }
        errorMessage = nil
        store.submitKPIGoals(userId: empId, year: year)
        Task {
            let client = APIClient(settings: settings)
            let saved = await store.save(client: client, session: session)
            if !saved { errorMessage = store.lastError ?? "저장에 실패했습니다." }
        }
    }
}

@MainActor
private struct NewKPIGoalView: View {
    @EnvironmentObject private var settings: AppSettings
    @EnvironmentObject private var session: SessionStore
    @ObservedObject var store: HRDataStore
    let year: Int
    let onSaved: () -> Void
    @Environment(\.dismiss) private var dismiss

    @State private var item = ""
    @State private var weightText = ""
    @State private var prev = ""
    @State private var goal = ""
    @State private var yoy = ""
    @State private var strategy = ""
    @State private var evalCriteria = ""
    @State private var isSaving = false
    @State private var errorMessage: String?

    private var client: APIClient { APIClient(settings: settings) }

    var body: some View {
        NavigationStack {
            Form {
                Section("\(year)년 KPI 목표") {
                    TextField("항목 *", text: $item)
                    TextField("비중(%) *", text: $weightText).keyboardType(.numberPad)
                    TextField("전년 실적", text: $prev)
                    TextField("목표", text: $goal, axis: .vertical)
                    TextField("전년 대비", text: $yoy)
                    TextField("추진 전략", text: $strategy, axis: .vertical)
                    TextField("평가 기준", text: $evalCriteria, axis: .vertical)
                }
                if let errorMessage {
                    Section { Text(errorMessage).font(.footnote).foregroundStyle(.red) }
                }
            }
            .navigationTitle("KPI 목표 등록")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("취소") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("등록") { Task { await submit() } }
                        .disabled(isSaving || item.trimmingCharacters(in: .whitespaces).isEmpty || (Double(weightText) ?? 0) <= 0)
                }
            }
        }
    }

    private func submit() async {
        guard let empId = session.currentEmployee?.id, let weight = Double(weightText), weight > 0 else { return }
        isSaving = true
        defer { isSaving = false }
        let nowISO = ISO8601DateFormatter().string(from: Date())
        let payload = NewKPIGoalPayload(
            id: newClientRecordId(), userId: empId, year: year, item: item, weight: weight,
            prev: prev, goal: goal, yoy: yoy, strategy: strategy, evalCriteria: evalCriteria,
            actual: "", rate: "", detail: "", selfScore: nil,
            firstScore: nil, firstComment: "", secondScore: nil, secondComment: "", secondCommentPublic: false,
            goalSub: 0, isDraft: false, firstStatus: "", firstReason: "",
            finalStatus: "", finalReason: "", finalConfirmed: false, finalScore: nil, updatedAt: nowISO
        )
        do {
            try store.appendKPIGoal(payload)
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

/// index.html의 KPI 결과 입력(자체평가) 모달을 옮겼다.
@MainActor
private struct KPISelfEvalView: View {
    @EnvironmentObject private var settings: AppSettings
    @EnvironmentObject private var session: SessionStore
    @ObservedObject var store: HRDataStore
    let entry: KPIEntry
    let onSaved: () -> Void
    @Environment(\.dismiss) private var dismiss

    @State private var actual: String
    @State private var rate: String
    @State private var detail: String
    @State private var selfScoreText: String
    @State private var isSaving = false
    @State private var errorMessage: String?

    private var client: APIClient { APIClient(settings: settings) }

    init(store: HRDataStore, entry: KPIEntry, onSaved: @escaping () -> Void) {
        self.store = store
        self.entry = entry
        self.onSaved = onSaved
        _actual = State(initialValue: entry.actual ?? "")
        _rate = State(initialValue: entry.rate ?? "")
        _detail = State(initialValue: entry.detail ?? "")
        _selfScoreText = State(initialValue: entry.selfScore.map { String(Int($0)) } ?? "")
    }

    var body: some View {
        NavigationStack {
            Form {
                Section(entry.item) {
                    if let goal = entry.goal, !goal.isEmpty {
                        LabeledContent("목표", value: goal)
                    }
                    if let weight = entry.weight {
                        LabeledContent("비중", value: "\(Int(weight))%")
                    }
                }
                Section("결과 입력") {
                    TextField("당해년도 실적", text: $actual)
                    TextField("달성율", text: $rate)
                    TextField("세부 추진 실적", text: $detail, axis: .vertical)
                    TextField("자체 평가 점수 (0~100)", text: $selfScoreText).keyboardType(.numberPad)
                }
                if let errorMessage {
                    Section { Text(errorMessage).font(.footnote).foregroundStyle(.red) }
                }
            }
            .navigationTitle("KPI 결과 입력")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("닫기") { dismiss() }
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
        let score = selfScoreText.isEmpty ? nil : Double(selfScoreText)
        guard store.updateKPISelfEval(id: entry.id, actual: actual, rate: rate, detail: detail, selfScore: score) else {
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
