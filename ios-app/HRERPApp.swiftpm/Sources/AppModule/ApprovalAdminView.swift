import SwiftUI

private let approvalAdminStatusOptions = ["all", "in_progress", "approved", "rejected"]
private let approvalAdminStatusLabels = [
    "all": "전체 상태", "in_progress": "진행중", "approved": "승인완료", "rejected": "반려",
]

/// 웹 앱(index.html)에는 "전체 결재 문서 조회" 관리자 페이지가 따로 없다 — 사용자 요청으로
/// 새로 추가한 화면. 관리자가 본인이 결재선에 없는 문서까지 포함해 전 직원의 결재 문서를
/// 조회하고, 정체된 문서를 강제로 반려 처리(ApprovalDetailView의 "관리자 강제 반려")할 수
/// 있다. 서버가 이 접근을 role로 막지 않으므로(POST /save 자체엔 권한 검증이 없음), 진입은
/// 반드시 role=="admin"일 때만 허용해야 한다(ERPHubView/SidebarRootView에서 이미 그렇게 함).
@MainActor
struct ApprovalAdminView: View {
    @EnvironmentObject private var settings: AppSettings
    @EnvironmentObject private var session: SessionStore
    @ObservedObject var store: HRDataStore
    let reload: () async -> Void

    @State private var query = ""
    @State private var statusFilter = "all"
    @State private var selectedDoc: ApprovalDocSummary?

    private var employeeName: [Int: String] {
        Dictionary(uniqueKeysWithValues: store.employees.map { ($0.id, $0.name) })
    }

    private var filtered: [ApprovalDocSummary] {
        var rows = store.approvalDocs.sorted { $0.createdAt > $1.createdAt }
        if statusFilter != "all" { rows = rows.filter { $0.status == statusFilter } }
        let q = query.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { return rows }
        return rows.filter {
            $0.title.localizedCaseInsensitiveContains(q)
                || (employeeName[$0.authorId]?.localizedCaseInsensitiveContains(q) ?? false)
        }
    }

    var body: some View {
        AppScreen {
            Picker("상태", selection: $statusFilter) {
                ForEach(approvalAdminStatusOptions, id: \.self) { Text(approvalAdminStatusLabels[$0] ?? $0).tag($0) }
            }
            .pickerStyle(.segmented)

            if filtered.isEmpty {
                EmptyState(message: "결재 문서가 없습니다.")
            }
            ForEach(filtered) { doc in
                AppCard {
                    HStack {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(doc.title).font(.subheadline.weight(.semibold))
                            Text("상신자: \(employeeName[doc.authorId] ?? "empId \(doc.authorId)")")
                                .font(.caption)
                                .foregroundStyle(AppTheme.secondaryText)
                        }
                        Spacer()
                        VStack(alignment: .trailing, spacing: 4) {
                            StatusPill(status: doc.status)
                            Text(doc.createdAt.prefix(10)).font(.caption).foregroundStyle(AppTheme.secondaryText)
                        }
                    }
                }
                .contentShape(Rectangle())
                .onTapGesture { selectedDoc = doc }
            }
        }
        .navigationTitle("전체 결재 관리 (\(filtered.count))")
        .searchable(text: $query, prompt: "제목·상신자 검색")
        .refreshable { await reload() }
        .sheet(item: $selectedDoc) { doc in
            ApprovalDetailView(doc: doc, store: store, onDecided: {
                selectedDoc = nil
            })
            .environmentObject(settings)
            .environmentObject(session)
        }
    }
}
