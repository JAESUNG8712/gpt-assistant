import SwiftUI

@MainActor
struct PMSView: View {
    @EnvironmentObject private var settings: AppSettings
    @EnvironmentObject private var session: SessionStore

    @State private var projects: [PMSProject] = []
    @State private var allocations: [PMSAllocation] = []
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var showingNewAllocation = false

    private var client: APIClient { APIClient(settings: settings) }
    private var projectName: [String: String] { Dictionary(uniqueKeysWithValues: projects.map { ($0.id, $0.name) }) }

    private var myAllocations: [PMSAllocation] {
        guard let empId = session.currentEmployee?.id else { return [] }
        return allocations
            .filter { $0.employeeId == String(empId) }
            .sorted { ($0.year, $0.month) > ($1.year, $1.month) }
    }

    /// 투입률 입력 시 고를 수 있는 프로젝트 목록 — 소속 팀원이 아닌 프로젝트까지 뜨면
    /// 실수로 엉뚱한 프로젝트에 투입률을 입력하기 쉬워서, 내가 멤버로 등록된 프로젝트
    /// (또는 멤버 제한이 아예 없는 프로젝트)로만 좁힌다. 관리자는 전체를 그대로 본다.
    private var myProjects: [PMSProject] {
        if session.currentEmployee?.role == "admin" { return projects }
        guard let empId = session.currentEmployee?.id else { return projects }
        let empIdString = String(empId)
        return projects.filter { project in
            guard let members = project.members, !members.isEmpty else { return true }
            return members.contains(empIdString)
        }
    }

    var body: some View {
        AppScreen {
            AppCard(title: "프로젝트 (\(projects.count))") {
                if projects.isEmpty && !isLoading {
                    EmptyState(message: "등록된 프로젝트가 없습니다.")
                } else {
                    ForEach(projects) { project in
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(project.name).font(.subheadline.weight(.semibold))
                                Text([project.startDate, project.endDate].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " ~ "))
                                    .font(.caption)
                                    .foregroundStyle(AppTheme.secondaryText)
                            }
                            Spacer()
                            StatusPill(status: project.status)
                        }
                        if project.id != projects.last?.id {
                            Divider()
                        }
                    }
                }
            }

            AppCard(title: "내 투입률") {
                if myAllocations.isEmpty && !isLoading {
                    EmptyState(message: "등록된 투입률이 없습니다.")
                } else {
                    ForEach(myAllocations) { allocation in
                        HStack {
                            Text("\(allocation.year)년 \(allocation.month)월 · \(projectName[allocation.projectId] ?? allocation.projectId)")
                                .font(.subheadline)
                            Spacer()
                            Text("\(Int(allocation.percent))%").font(.subheadline.weight(.bold))
                        }
                        if allocation.id != myAllocations.last?.id {
                            Divider()
                        }
                    }
                }

                Button {
                    showingNewAllocation = true
                } label: {
                    Label("투입률 입력", systemImage: "plus")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .tint(AppTheme.accent)
                .padding(.top, 4)
            }

            if let errorMessage {
                AppCard { Text(errorMessage).font(.footnote).foregroundStyle(AppTheme.danger) }
            }
        }
        .navigationTitle("PMS")
        .task { await load() }
        .refreshable { await load() }
        .sheet(isPresented: $showingNewAllocation) {
            NewAllocationView(projects: myProjects) {
                Task { await load() }
            }
            .environmentObject(settings)
            .environmentObject(session)
        }
    }

    private func load() async {
        guard let token = session.token else { return }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            async let p = client.fetchPMSProjects(token: token)
            async let a = client.fetchPMSAllocations(token: token)
            (projects, allocations) = try await (p, a)
        } catch {
            if case APIError.serverError(401, _) = error {
                session.handleUnauthorized()
            } else {
                errorMessage = error.localizedDescription
            }
        }
    }
}

@MainActor
private struct NewAllocationView: View {
    @EnvironmentObject private var settings: AppSettings
    @EnvironmentObject private var session: SessionStore
    @Environment(\.dismiss) private var dismiss

    let projects: [PMSProject]
    let onSaved: () -> Void

    @State private var selectedProjectID: String = ""
    @State private var year = Calendar.current.component(.year, from: Date())
    @State private var month = Calendar.current.component(.month, from: Date())
    @State private var percent: Double = 100
    @State private var memo = ""
    @State private var isSaving = false
    @State private var errorMessage: String?

    private var client: APIClient { APIClient(settings: settings) }

    var body: some View {
        NavigationStack {
            Form {
                Section("프로젝트") {
                    Picker("프로젝트", selection: $selectedProjectID) {
                        Text("선택하세요").tag("")
                        ForEach(projects) { project in
                            Text(project.name).tag(project.id)
                        }
                    }
                }
                Section("기간 / 투입률") {
                    Stepper("연도: \(year)", value: $year, in: 2020...2100)
                    Stepper("월: \(month)", value: $month, in: 1...12)
                    HStack {
                        Text("투입률")
                        Slider(value: $percent, in: 1...100, step: 1)
                        Text("\(Int(percent))%").frame(width: 44)
                    }
                }
                Section("메모") {
                    TextField("메모 (선택)", text: $memo)
                }
                if let errorMessage {
                    Section { Text(errorMessage).font(.footnote).foregroundStyle(.red) }
                }
            }
            .navigationTitle("투입률 입력")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("취소") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("저장") { Task { await save() } }
                        .disabled(isSaving || selectedProjectID.isEmpty)
                }
            }
        }
    }

    private func save() async {
        guard let empId = session.currentEmployee?.id, let token = session.token else { return }
        isSaving = true
        defer { isSaving = false }
        let payload = NewPMSAllocationPayload(
            employeeId: empId, year: year, month: month,
            projectId: selectedProjectID, percent: percent, memo: memo
        )
        do {
            try await client.createPMSAllocation(payload, token: token)
            onSaved()
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
