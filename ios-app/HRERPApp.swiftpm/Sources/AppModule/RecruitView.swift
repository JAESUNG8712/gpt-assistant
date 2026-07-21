import SwiftUI

private let recruitStatusOptions = ["open", "closed"]
private let recruitStatusLabels = ["open": "모집중", "closed": "마감"]
private let defaultRecruitStages = ["서류전형", "1차면접", "2차면접", "최종합격"]

@MainActor
struct RecruitView: View {
    @EnvironmentObject private var settings: AppSettings
    @EnvironmentObject private var session: SessionStore

    private enum Tab: String, CaseIterable, Identifiable {
        case jobs = "채용공고"
        case candidates = "지원자"
        var id: String { rawValue }
    }

    @State private var tab: Tab = .jobs
    @State private var jobs: [RecruitJob] = []
    @State private var candidates: [RecruitCandidate] = []
    @State private var query = ""
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var showingNewJob = false
    @State private var showingNewCandidate = false
    @State private var selectedCandidate: RecruitCandidate?

    private var client: APIClient { APIClient(settings: settings) }
    private var jobTitle: [String: String] { Dictionary(uniqueKeysWithValues: jobs.map { ($0.id, $0.title) }) }
    /// 서버가 공고/지원자 쓰기를 admin뿐 아니라 leader/director에게도 허용한다
    /// (requireRole(["admin","leader","director"])) — 다른 관리자 기능과 권한 기준이 다르다.
    private var canManageRecruit: Bool {
        guard let role = session.currentEmployee?.role else { return false }
        return ["admin", "leader", "director"].contains(role)
    }

    private var filteredCandidates: [RecruitCandidate] {
        guard !query.trimmingCharacters(in: .whitespaces).isEmpty else { return candidates }
        return candidates.filter {
            $0.name.localizedCaseInsensitiveContains(query)
                || ($0.email?.localizedCaseInsensitiveContains(query) ?? false)
        }
    }

    var body: some View {
        AppScreen {
            Picker("보기", selection: $tab) {
                ForEach(Tab.allCases) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)

            if let errorMessage {
                AppCard { Text(errorMessage).font(.footnote).foregroundStyle(AppTheme.danger) }
            }

            switch tab {
            case .jobs:
                if jobs.isEmpty && !isLoading { EmptyState(message: "등록된 채용공고가 없습니다.") }
                ForEach(jobs) { job in
                    AppCard {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(job.title).font(.subheadline.weight(.semibold))
                                Text([job.department, job.team].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                                    .font(.caption)
                                    .foregroundStyle(AppTheme.secondaryText)
                            }
                            Spacer()
                            VStack(alignment: .trailing, spacing: 2) {
                                if let headcount = job.headcount {
                                    Text("\(headcount)명").font(.caption).foregroundStyle(AppTheme.secondaryText)
                                }
                                StatusPill(status: job.status)
                            }
                        }
                    }
                }
            case .candidates:
                if filteredCandidates.isEmpty && !isLoading { EmptyState(message: "지원자가 없습니다.") }
                ForEach(filteredCandidates) { candidate in
                    AppCard {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(candidate.name).font(.subheadline.weight(.semibold))
                                Text(candidate.jobId.flatMap { jobTitle[$0] } ?? "")
                                    .font(.caption)
                                    .foregroundStyle(AppTheme.secondaryText)
                            }
                            Spacer()
                            StatusPill(status: candidate.status)
                        }
                    }
                    .contentShape(Rectangle())
                    .onTapGesture { if canManageRecruit { selectedCandidate = candidate } }
                }
            }
        }
        .navigationTitle("채용")
        .searchable(text: $query, prompt: "지원자 이름/이메일 검색")
        .task { await load() }
        .refreshable { await load() }
        .toolbar {
            if canManageRecruit {
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        if tab == .jobs { showingNewJob = true } else { showingNewCandidate = true }
                    } label: {
                        Image(systemName: "plus")
                    }
                }
            }
        }
        .sheet(isPresented: $showingNewJob) {
            NewJobView { Task { await load() } }
                .environmentObject(settings)
                .environmentObject(session)
        }
        .sheet(isPresented: $showingNewCandidate) {
            NewCandidateView(jobs: jobs) { Task { await load() } }
                .environmentObject(settings)
                .environmentObject(session)
        }
        .sheet(item: $selectedCandidate) { candidate in
            CandidateStatusView(candidate: candidate, job: candidate.jobId.flatMap { jid in jobs.first { $0.id == jid } }) {
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
            async let j = client.fetchRecruitJobs(token: token)
            async let c = client.fetchRecruitCandidates(token: token)
            (jobs, candidates) = try await (j, c)
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
private struct NewJobView: View {
    @EnvironmentObject private var settings: AppSettings
    @EnvironmentObject private var session: SessionStore
    @Environment(\.dismiss) private var dismiss
    let onSaved: () -> Void

    @State private var title = ""
    @State private var department = ""
    @State private var team = ""
    @State private var headcount = 1
    @State private var status = "open"
    @State private var description = ""
    @State private var isSaving = false
    @State private var errorMessage: String?

    private var client: APIClient { APIClient(settings: settings) }

    var body: some View {
        NavigationStack {
            Form {
                Section("공고") {
                    TextField("공고 제목 *", text: $title)
                    TextField("부서", text: $department)
                    TextField("팀", text: $team)
                    Stepper("모집 인원: \(headcount)명", value: $headcount, in: 1...50)
                    Picker("상태", selection: $status) {
                        ForEach(recruitStatusOptions, id: \.self) { Text(recruitStatusLabels[$0] ?? $0).tag($0) }
                    }
                    TextField("설명 (선택)", text: $description, axis: .vertical)
                }
                if let errorMessage {
                    Section { Text(errorMessage).font(.footnote).foregroundStyle(.red) }
                }
            }
            .navigationTitle("채용공고 등록")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("취소") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("등록") { Task { await submit() } }
                        .disabled(isSaving || title.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
    }

    private func submit() async {
        guard let admin = session.currentEmployee, let token = session.token else { return }
        isSaving = true
        defer { isSaving = false }
        do {
            _ = try await client.saveRecruitJob(
                id: nil, title: title, department: department, team: team,
                headcount: headcount, status: status, description: description, user: admin.name, token: token
            )
            onSaved()
            dismiss()
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
private struct NewCandidateView: View {
    @EnvironmentObject private var settings: AppSettings
    @EnvironmentObject private var session: SessionStore
    @Environment(\.dismiss) private var dismiss
    let jobs: [RecruitJob]
    let onSaved: () -> Void

    @State private var jobId = ""
    @State private var name = ""
    @State private var email = ""
    @State private var phone = ""
    @State private var memo = ""
    @State private var isSaving = false
    @State private var errorMessage: String?

    private var client: APIClient { APIClient(settings: settings) }
    private var openJobs: [RecruitJob] { jobs.filter { $0.status == "open" } }

    var body: some View {
        NavigationStack {
            Form {
                Section("지원자") {
                    Picker("채용공고 *", selection: $jobId) {
                        Text("선택").tag("")
                        ForEach(openJobs) { Text($0.title).tag($0.id) }
                    }
                    TextField("이름 *", text: $name)
                    TextField("이메일", text: $email).keyboardType(.emailAddress)
                    TextField("전화번호", text: $phone).keyboardType(.phonePad)
                    TextField("메모 (선택)", text: $memo, axis: .vertical)
                }
                if let errorMessage {
                    Section { Text(errorMessage).font(.footnote).foregroundStyle(.red) }
                }
            }
            .navigationTitle("지원자 등록")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("취소") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("등록") { Task { await submit() } }
                        .disabled(isSaving || jobId.isEmpty || name.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
    }

    private func submit() async {
        guard let admin = session.currentEmployee, let token = session.token else { return }
        isSaving = true
        defer { isSaving = false }
        do {
            _ = try await client.createRecruitCandidate(jobId: jobId, name: name, email: email, phone: phone, memo: memo, user: admin.name, token: token)
            onSaved()
            dismiss()
        } catch {
            if case APIError.serverError(401, _) = error {
                session.handleUnauthorized()
            } else {
                errorMessage = error.localizedDescription
            }
        }
    }
}

/// 지원자 전형 단계 변경. index.html처럼 면접 평가 결과를 근거로 통과 기준 미만 점수의
/// 다음 단계 진행 시 서버가 사유를 요구할 수 있지만(이 앱은 면접 평가 자체를 다루지 않아
/// 실제로는 거의 발생하지 않음), 만약을 대비해 사유 필드를 항상 함께 받는다.
@MainActor
private struct CandidateStatusView: View {
    @EnvironmentObject private var settings: AppSettings
    @EnvironmentObject private var session: SessionStore
    @Environment(\.dismiss) private var dismiss
    let candidate: RecruitCandidate
    let job: RecruitJob?
    let onSaved: () -> Void

    @State private var status = ""
    @State private var reason = ""
    @State private var isSaving = false
    @State private var errorMessage: String?

    private var client: APIClient { APIClient(settings: settings) }
    private var stages: [String] { job?.stages ?? defaultRecruitStages }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    LabeledContent("지원자", value: candidate.name)
                    LabeledContent("현재 단계") { StatusPill(status: candidate.status) }
                }
                Section("전형 단계 변경") {
                    Picker("변경할 단계", selection: $status) {
                        ForEach(stages, id: \.self) { Text($0).tag($0) }
                    }
                    TextField("사유 (단계를 건너뛰거나 낮은 평가로 진행 시 필요할 수 있음)", text: $reason, axis: .vertical)
                }
                if let errorMessage {
                    Section { Text(errorMessage).font(.footnote).foregroundStyle(.red) }
                }
            }
            .navigationTitle("전형 단계 변경")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("닫기") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("저장") { Task { await submit() } }
                        .disabled(isSaving || status.isEmpty || status == candidate.status)
                }
            }
            .onAppear { if status.isEmpty { status = candidate.status } }
        }
    }

    private func submit() async {
        guard let token = session.token else { return }
        isSaving = true
        defer { isSaving = false }
        do {
            try await client.updateRecruitCandidateStatus(id: candidate.id, status: status, reason: reason, token: token)
            onSaved()
            dismiss()
        } catch {
            if case APIError.serverError(401, _) = error {
                session.handleUnauthorized()
            } else {
                errorMessage = error.localizedDescription
            }
        }
    }
}
