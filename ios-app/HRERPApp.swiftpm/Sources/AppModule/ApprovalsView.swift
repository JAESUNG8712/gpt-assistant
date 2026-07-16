import SwiftUI

@MainActor
struct ApprovalsView: View {
    @EnvironmentObject private var settings: AppSettings
    @EnvironmentObject private var session: SessionStore
    @ObservedObject var store: HRDataStore
    let reload: () async -> Void

    @State private var selectedDoc: ApprovalDocSummary?
    @State private var showingNewDoc = false

    private var client: APIClient { APIClient(settings: settings) }

    private var toApprove: [ApprovalDocSummary] {
        guard let empId = session.currentEmployee?.id else { return [] }
        return store.approvalDocs
            .filter { $0.status == "in_progress" && $0.approvers.contains { $0.empId == empId && $0.status == "pending" } }
            .sorted { $0.createdAt > $1.createdAt }
    }

    private var myOutbox: [ApprovalDocSummary] {
        guard let empId = session.currentEmployee?.id else { return [] }
        return store.approvalDocs
            .filter { $0.authorId == empId }
            .sorted { $0.createdAt > $1.createdAt }
    }

    var body: some View {
        AppScreen {
            AppCard(title: "내가 결재할 문서 (\(toApprove.count))") {
                if toApprove.isEmpty {
                    EmptyState(message: "결재할 문서가 없습니다.")
                } else {
                    ForEach(toApprove) { doc in
                        ApprovalRow(doc: doc).onTapGesture { selectedDoc = doc }
                        if doc.id != toApprove.last?.id { Divider() }
                    }
                }
            }
            AppCard(title: "내가 상신한 문서 (\(myOutbox.count))") {
                if myOutbox.isEmpty {
                    EmptyState(message: "상신한 문서가 없습니다.")
                } else {
                    ForEach(myOutbox) { doc in
                        ApprovalRow(doc: doc).onTapGesture { selectedDoc = doc }
                        if doc.id != myOutbox.last?.id { Divider() }
                    }
                }
            }
        }
        .navigationTitle("전자결재")
        .refreshable { await reload() }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    showingNewDoc = true
                } label: {
                    Image(systemName: "square.and.pencil")
                }
            }
        }
        .sheet(item: $selectedDoc) { doc in
            ApprovalDetailView(doc: doc, store: store, onDecided: {
                selectedDoc = nil
            })
            .environmentObject(settings)
            .environmentObject(session)
        }
        .sheet(isPresented: $showingNewDoc) {
            NewApprovalView(store: store)
                .environmentObject(settings)
                .environmentObject(session)
        }
    }
}

private struct ApprovalRow: View {
    let doc: ApprovalDocSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(doc.title).font(.subheadline.weight(.semibold)).foregroundStyle(AppTheme.primaryText)
            HStack {
                StatusPill(status: doc.status)
                Spacer()
                Text(doc.createdAt.prefix(10)).font(.caption).foregroundStyle(AppTheme.secondaryText)
            }
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
    }
}

@MainActor
private struct ApprovalDetailView: View {
    @EnvironmentObject private var settings: AppSettings
    @EnvironmentObject private var session: SessionStore
    @Environment(\.dismiss) private var dismiss

    let doc: ApprovalDocSummary
    @ObservedObject var store: HRDataStore
    let onDecided: () -> Void

    @State private var comment = ""
    @State private var isDeciding = false
    @State private var errorMessage: String?

    private var client: APIClient { APIClient(settings: settings) }

    private var canDecide: Bool {
        guard let empId = session.currentEmployee?.id else { return false }
        return doc.status == "in_progress" && doc.approvers.contains { $0.empId == empId && $0.status == "pending" }
    }

    var body: some View {
        NavigationStack {
            AppScreen {
                AppCard {
                    LabeledContent("제목", value: doc.title)
                    LabeledContent("상태") { StatusPill(status: doc.status) }
                    LabeledContent("상신일", value: doc.createdAt.prefix(16).replacingOccurrences(of: "T", with: " "))
                }

                if let content = doc.formData["content"], !content.isEmpty {
                    AppCard(title: "내용") {
                        Text(content).font(.subheadline).foregroundStyle(AppTheme.primaryText)
                    }
                }

                AppCard(title: "결재선") {
                    ForEach(Array(doc.approvers.enumerated()), id: \.offset) { index, approver in
                        HStack {
                            Text("\(index + 1)차 \(approver.label ?? "")")
                            Spacer()
                            StatusPill(status: approver.status)
                        }
                        if index != doc.approvers.count - 1 { Divider() }
                    }
                }

                if canDecide {
                    AppCard(title: "의견") {
                        TextField("결재 의견 (선택)", text: $comment, axis: .vertical)
                            .appFieldStyle()

                        HStack(spacing: 10) {
                            Button("승인") { Task { await decide(.approve) } }
                                .buttonStyle(AppPrimaryButtonStyle(isDisabled: isDeciding))
                                .disabled(isDeciding)
                            Button("반려") { Task { await decide(.reject) } }
                                .buttonStyle(.bordered)
                                .tint(AppTheme.danger)
                                .disabled(isDeciding)
                        }
                    }
                }

                if let errorMessage {
                    AppCard { Text(errorMessage).font(.footnote).foregroundStyle(AppTheme.danger) }
                }
            }
            .navigationTitle("결재 상세")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("닫기") { dismiss() }
                }
            }
        }
    }

    private func decide(_ action: HRDataStore.ApprovalAction) async {
        guard let empId = session.currentEmployee?.id else { return }
        isDeciding = true
        defer { isDeciding = false }
        guard store.decideApproval(docId: doc.id, empId: empId, action: action, comment: comment) else {
            errorMessage = "이미 처리된 문서입니다."
            return
        }
        let saved = await store.save(client: client, session: session)
        if saved {
            onDecided()
            dismiss()
        } else {
            errorMessage = store.lastError ?? "저장에 실패했습니다."
        }
    }
}

/// index.html의 "일반 결재"(tpl-general: 제목+내용) 템플릿으로 상신한다. 휴가·경비·거래처 등록
/// 같은 템플릿별 전용 양식(동적 필드)은 이 화면의 범위 밖이다 — approvalTemplates를 불러와
/// 필드를 동적으로 그려야 해서 별도 작업이 필요하다.
@MainActor
private struct NewApprovalView: View {
    @EnvironmentObject private var settings: AppSettings
    @EnvironmentObject private var session: SessionStore
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var store: HRDataStore

    @State private var docTitle = ""
    @State private var content = ""
    @State private var approvers: [Employee] = []
    @State private var showingApproverPicker = false
    @State private var isSaving = false
    @State private var errorMessage: String?

    private var client: APIClient { APIClient(settings: settings) }

    var body: some View {
        NavigationStack {
            AppScreen {
                AppCard(title: "제목") {
                    TextField("결재 제목", text: $docTitle).appFieldStyle()
                }
                AppCard(title: "내용") {
                    TextField("결재 내용", text: $content, axis: .vertical)
                        .lineLimit(4...10)
                        .appFieldStyle()
                }
                AppCard(title: "결재선 (\(approvers.count)명)") {
                    if approvers.isEmpty {
                        EmptyState(message: "결재자를 1명 이상 추가하세요.")
                    } else {
                        ForEach(Array(approvers.enumerated()), id: \.offset) { index, approver in
                            HStack {
                                Text("\(index + 1)차").foregroundStyle(AppTheme.secondaryText)
                                Text(approver.name)
                                Spacer()
                                Button {
                                    approvers.remove(at: index)
                                } label: {
                                    Image(systemName: "xmark.circle.fill").foregroundStyle(AppTheme.secondaryText)
                                }
                            }
                            if index != approvers.count - 1 { Divider() }
                        }
                    }
                    Button {
                        showingApproverPicker = true
                    } label: {
                        Label("결재자 추가", systemImage: "plus")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .tint(AppTheme.accent)
                    .padding(.top, 4)
                }

                if let errorMessage {
                    AppCard { Text(errorMessage).font(.footnote).foregroundStyle(AppTheme.danger) }
                }
            }
            .navigationTitle("결재 상신")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("취소") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("상신") { Task { await submit() } }
                        .disabled(isSaving || docTitle.trimmingCharacters(in: .whitespaces).isEmpty || content.isEmpty || approvers.isEmpty)
                }
            }
            .sheet(isPresented: $showingApproverPicker) {
                ApproverPickerView(candidates: store.employees.filter { emp in !approvers.contains(where: { $0.id == emp.id }) }) { selected in
                    approvers.append(selected)
                }
            }
        }
    }

    private func submit() async {
        guard let employee = session.currentEmployee else { return }
        isSaving = true
        defer { isSaving = false }

        let now = ISO8601DateFormatter().string(from: Date())
        let approverPayloads = approvers.enumerated().map { index, emp in
            NewApproverPayload(
                empId: emp.id, label: "결재자",
                status: index == 0 ? "pending" : "waiting",
                decidedAt: nil, comment: ""
            )
        }
        let payload = NewApprovalDocPayload(
            id: Int(Date().timeIntervalSince1970 * 1000),
            templateId: "tpl-general",
            authorId: employee.id,
            title: docTitle,
            createdAt: now, updatedAt: now,
            status: "in_progress",
            formData: ["docTitle": docTitle, "content": content],
            approvers: approverPayloads,
            receivers: [], cc: [], attachments: []
        )

        do {
            try store.appendApprovalDoc(payload)
        } catch {
            errorMessage = error.localizedDescription
            return
        }

        let saved = await store.save(client: client, session: session)
        if saved {
            dismiss()
        } else {
            errorMessage = store.lastError ?? "저장에 실패했습니다."
        }
    }
}

@MainActor
private struct ApproverPickerView: View {
    @Environment(\.dismiss) private var dismiss
    let candidates: [Employee]
    let onPick: (Employee) -> Void

    @State private var query = ""

    private var filtered: [Employee] {
        guard !query.trimmingCharacters(in: .whitespaces).isEmpty else {
            return candidates.sorted { $0.name < $1.name }
        }
        return candidates
            .filter { $0.name.localizedCaseInsensitiveContains(query) || ($0.dept?.localizedCaseInsensitiveContains(query) ?? false) }
            .sorted { $0.name < $1.name }
    }

    var body: some View {
        NavigationStack {
            AppScreen {
                ForEach(filtered) { employee in
                    AppCard {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(employee.name).font(.subheadline.weight(.semibold))
                                Text([employee.dept, employee.team].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                                    .font(.caption)
                                    .foregroundStyle(AppTheme.secondaryText)
                            }
                            Spacer()
                        }
                    }
                    .contentShape(Rectangle())
                    .onTapGesture {
                        onPick(employee)
                        dismiss()
                    }
                }
            }
            .searchable(text: $query, prompt: "이름·부서 검색")
            .navigationTitle("결재자 선택")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("닫기") { dismiss() }
                }
            }
        }
    }
}
