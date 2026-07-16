import SwiftUI

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

    private var client: APIClient { APIClient(settings: settings) }
    private var jobTitle: [String: String] { Dictionary(uniqueKeysWithValues: jobs.map { ($0.id, $0.title) }) }

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
                }
            }
        }
        .navigationTitle("채용")
        .searchable(text: $query, prompt: "지원자 이름/이메일 검색")
        .task { await load() }
        .refreshable { await load() }
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
            errorMessage = error.localizedDescription
        }
    }
}
