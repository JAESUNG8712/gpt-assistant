import SwiftUI

// MainActor로 격리되지 않은 최상위 상수 — @MainActor 타입(NewExpenseClaimView) 안의
// static 프로퍼티였을 때는 nonisolated 컨텍스트(DraftItem의 기본값 초기화)에서 참조할 수
// 없어 Swift 6 언어 모드에서 컴파일 에러가 났다.
private let expenseCategories = ["교통비", "식대", "숙박비", "소모품비", "접대비", "통신비", "교육비", "기타"]

@MainActor
struct ExpenseView: View {
    @EnvironmentObject private var settings: AppSettings
    @EnvironmentObject private var session: SessionStore
    @ObservedObject var store: HRDataStore
    let reload: () async -> Void

    @State private var showingNewClaim = false

    private var client: APIClient { APIClient(settings: settings) }

    private var myClaims: [ExpenseClaim] {
        guard let empId = session.currentEmployee?.id else { return [] }
        return store.expenseClaims
            .filter { $0.empId == empId }
            .sorted { $0.createdAt > $1.createdAt }
    }

    var body: some View {
        AppScreen {
            if myClaims.isEmpty {
                EmptyState(message: "제출한 경비청구가 없습니다.")
            }
            ForEach(myClaims) { claim in
                AppCard {
                    HStack {
                        Text(claim.title).font(.subheadline.weight(.semibold))
                        Spacer()
                        StatusPill(status: claim.status)
                    }
                    Text("\(Int(claim.total).formatted())원 · \(claim.items.count)건")
                        .font(.subheadline)
                        .foregroundStyle(AppTheme.secondaryText)
                    HStack {
                        Text(claim.createdAt.prefix(10)).font(.caption).foregroundStyle(AppTheme.secondaryText)
                        Spacer()
                        if claim.status == "pending" {
                            Button("회수", role: .destructive) {
                                store.withdrawExpenseClaim(id: claim.id)
                                Task { await store.save(client: client, session: session) }
                            }
                            .font(.caption)
                        }
                    }
                }
            }
        }
        .navigationTitle("경비청구")
        .refreshable { await reload() }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    showingNewClaim = true
                } label: {
                    Image(systemName: "plus")
                }
            }
        }
        .sheet(isPresented: $showingNewClaim) {
            NewExpenseClaimView(store: store)
                .environmentObject(settings)
                .environmentObject(session)
        }
    }
}

@MainActor
private struct NewExpenseClaimView: View {
    @EnvironmentObject private var settings: AppSettings
    @EnvironmentObject private var session: SessionStore
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var store: HRDataStore

    private struct DraftItem: Identifiable {
        let id = UUID()
        var date = DateHelpers.todayDateString()
        var category = expenseCategories[0]
        var amount: Double = 0
        var memo = ""
    }

    @State private var title = ""
    @State private var items: [DraftItem] = [DraftItem()]
    @State private var isSaving = false
    @State private var errorMessage: String?

    private var client: APIClient { APIClient(settings: settings) }
    private var total: Double { items.reduce(0) { $0 + $1.amount } }

    var body: some View {
        NavigationStack {
            Form {
                Section("제목") {
                    TextField("예: 3월 영업 출장비", text: $title)
                }

                Section("항목") {
                    ForEach($items) { $item in
                        VStack(alignment: .leading, spacing: 6) {
                            Picker("분류", selection: $item.category) {
                                ForEach(expenseCategories, id: \.self) { Text($0) }
                            }
                            TextField("금액", value: $item.amount, format: .number)
                                .keyboardType(.numberPad)
                            TextField("메모 (선택)", text: $item.memo)
                        }
                        .padding(.vertical, 4)
                    }
                    .onDelete { items.remove(atOffsets: $0) }

                    Button("+ 항목 추가") { items.append(DraftItem()) }
                }

                Section {
                    LabeledContent("합계", value: "\(Int(total).formatted())원")
                }

                if let errorMessage {
                    Section {
                        Text(errorMessage).font(.footnote).foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("경비청구 작성")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("취소") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("제출") { Task { await submit() } }
                        .disabled(isSaving || title.trimmingCharacters(in: .whitespaces).isEmpty || total <= 0)
                }
            }
        }
    }

    private func submit() async {
        guard let employee = session.currentEmployee else { return }
        isSaving = true
        defer { isSaving = false }

        let validItems = items.filter { $0.amount > 0 }
        guard !validItems.isEmpty else {
            errorMessage = "금액이 입력된 항목이 1건 이상 필요합니다."
            return
        }

        let payload = NewExpenseClaimPayload(
            id: newClientRecordId(),
            empId: employee.id,
            empName: employee.name,
            dept: employee.dept ?? "",
            team: employee.team ?? "",
            title: title,
            items: validItems.map { ExpenseItem(date: $0.date, category: $0.category, amount: $0.amount, memo: $0.memo) },
            total: validItems.reduce(0) { $0 + $1.amount },
            receipts: [],
            status: "pending",
            createdAt: ISO8601DateFormatter().string(from: Date())
        )

        do {
            try store.appendExpenseClaim(payload)
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
