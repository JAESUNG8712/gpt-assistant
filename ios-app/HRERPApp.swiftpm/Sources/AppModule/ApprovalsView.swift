import SwiftUI

@MainActor
struct ApprovalsView: View {
    @EnvironmentObject private var settings: AppSettings
    @EnvironmentObject private var session: SessionStore
    @ObservedObject var store: HRDataStore
    let reload: () async -> Void

    @State private var selectedDoc: ApprovalDocSummary?

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
        NavigationStack {
            List {
                Section("내가 결재할 문서 (\(toApprove.count))") {
                    if toApprove.isEmpty {
                        ContentUnavailableFallback(message: "결재할 문서가 없습니다.")
                    }
                    ForEach(toApprove) { doc in
                        ApprovalRow(doc: doc).onTapGesture { selectedDoc = doc }
                    }
                }
                Section("내가 상신한 문서 (\(myOutbox.count))") {
                    if myOutbox.isEmpty {
                        ContentUnavailableFallback(message: "상신한 문서가 없습니다.")
                    }
                    ForEach(myOutbox) { doc in
                        ApprovalRow(doc: doc).onTapGesture { selectedDoc = doc }
                    }
                }
            }
            .navigationTitle("전자결재")
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
}

private struct ApprovalRow: View {
    let doc: ApprovalDocSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(doc.title).font(.headline)
            HStack {
                StatusBadge(status: doc.status)
                Spacer()
                Text(doc.createdAt.prefix(10)).font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
    }
}

struct StatusBadge: View {
    let status: String

    private var label: String {
        switch status {
        case "in_progress": return "진행중"
        case "approved": return "승인완료"
        case "rejected": return "반려"
        case "cancelled": return "취소"
        case "pending": return "대기"
        case "waiting": return "대기"
        default: return status
        }
    }

    private var color: Color {
        switch status {
        case "approved": return .green
        case "rejected": return .red
        case "cancelled": return .gray
        default: return .orange
        }
    }

    var body: some View {
        Text(label)
            .font(.caption)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(color.opacity(0.15))
            .foregroundStyle(color)
            .clipShape(Capsule())
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
            Form {
                Section {
                    LabeledContent("제목", value: doc.title)
                    LabeledContent("상태") { StatusBadge(status: doc.status) }
                    LabeledContent("상신일", value: doc.createdAt.prefix(16).replacingOccurrences(of: "T", with: " "))
                }

                Section("결재선") {
                    ForEach(Array(doc.approvers.enumerated()), id: \.offset) { index, approver in
                        HStack {
                            Text("\(index + 1)차 \(approver.label ?? "")")
                            Spacer()
                            StatusBadge(status: approver.status)
                        }
                    }
                }

                if canDecide {
                    Section("의견") {
                        TextField("결재 의견 (선택)", text: $comment, axis: .vertical)
                    }
                    Section {
                        HStack {
                            Button("승인") { Task { await decide(.approve) } }
                                .buttonStyle(.borderedProminent)
                                .disabled(isDeciding)
                            Button("반려", role: .destructive) { Task { await decide(.reject) } }
                                .buttonStyle(.bordered)
                                .disabled(isDeciding)
                        }
                        .frame(maxWidth: .infinity)
                    }
                }

                if let errorMessage {
                    Section {
                        Text(errorMessage).font(.footnote).foregroundStyle(.red)
                    }
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
