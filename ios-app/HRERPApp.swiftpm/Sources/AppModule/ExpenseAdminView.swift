import SwiftUI

private let expenseAdminStatusOptions = ["all", "pending", "approved", "rejected", "paid"]
private let expenseAdminStatusLabels = [
    "all": "전체 상태", "pending": "승인 대기", "approved": "승인됨(지급 전)",
    "rejected": "반려", "paid": "지급완료",
]

/// index.html의 renderExpenseAdminPage()를 옮겼다 — 관리자가 전 직원의 경비청구를
/// 조회·승인·반려·지급 처리한다(일반 ExpenseView는 본인 청구만 보임). 서버가 이 화면의
/// 대상 문서 접근을 role로 막지 않으므로(POST /save 자체엔 권한 검증이 없음), 진입은
/// 반드시 role=="admin"일 때만 허용해야 한다(ERPHubView/SidebarRootView에서 이미 그렇게 함).
@MainActor
struct ExpenseAdminView: View {
    @EnvironmentObject private var settings: AppSettings
    @EnvironmentObject private var session: SessionStore
    @ObservedObject var store: HRDataStore
    let reload: () async -> Void

    @State private var query = ""
    @State private var statusFilter = "all"

    private var pendingCount: Int { store.expenseClaims.filter { $0.status == "pending" }.count }
    private var approvedCount: Int { store.expenseClaims.filter { $0.status == "approved" }.count }

    private var filtered: [ExpenseClaim] {
        var rows = store.expenseClaims.sorted { $0.createdAt > $1.createdAt }
        if statusFilter != "all" { rows = rows.filter { $0.status == statusFilter } }
        let q = query.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { return rows }
        return rows.filter {
            ($0.empName?.localizedCaseInsensitiveContains(q) ?? false)
                || ($0.dept?.localizedCaseInsensitiveContains(q) ?? false)
                || $0.title.localizedCaseInsensitiveContains(q)
        }
    }

    var body: some View {
        AppScreen {
            Text("대기 \(pendingCount)건 · 지급 대기 \(approvedCount)건")
                .font(.caption)
                .foregroundStyle(AppTheme.secondaryText)

            Picker("상태", selection: $statusFilter) {
                ForEach(expenseAdminStatusOptions, id: \.self) { Text(expenseAdminStatusLabels[$0] ?? $0).tag($0) }
            }
            .pickerStyle(.segmented)

            if filtered.isEmpty {
                EmptyState(message: "청구 내역이 없습니다.")
            }
            ForEach(filtered) { claim in
                NavigationLink {
                    ExpenseClaimAdminDetailView(store: store, claimId: claim.id) {
                        Task { await reload() }
                    }
                } label: {
                    AppCard {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(claim.title).font(.subheadline.weight(.semibold))
                                Text([claim.empName, claim.dept, claim.team].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                                    .font(.caption)
                                    .foregroundStyle(AppTheme.secondaryText)
                            }
                            Spacer()
                            VStack(alignment: .trailing, spacing: 2) {
                                Text("\(Int(claim.total).formatted())원").font(.subheadline.weight(.bold))
                                StatusPill(status: claim.status)
                            }
                        }
                    }
                }
                .buttonStyle(.plain)
            }
        }
        .navigationTitle("경비 정산 관리")
        .searchable(text: $query, prompt: "청구자·부서·제목 검색")
        .refreshable { await reload() }
    }
}

@MainActor
private struct ExpenseClaimAdminDetailView: View {
    @EnvironmentObject private var settings: AppSettings
    @EnvironmentObject private var session: SessionStore
    @ObservedObject var store: HRDataStore
    let claimId: Int
    let onChanged: () -> Void

    @State private var rejectReason = ""
    @State private var isSaving = false
    @State private var errorMessage: String?
    @State private var showingPay = false

    private var client: APIClient { APIClient(settings: settings) }
    private var claim: ExpenseClaim? { store.expenseClaims.first { $0.id == claimId } }

    var body: some View {
        Group {
            if let claim {
                AppScreen {
                    AppCard {
                        LabeledContent("제목", value: claim.title)
                        LabeledContent("청구자", value: [claim.empName, claim.dept, claim.team].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                        LabeledContent("청구일", value: String(claim.createdAt.prefix(10)))
                        LabeledContent("합계", value: "\(Int(claim.total).formatted())원")
                        LabeledContent("상태") { StatusPill(status: claim.status) }
                    }

                    AppCard(title: "항목 (\(claim.items.count)건)") {
                        ForEach(Array(claim.items.enumerated()), id: \.offset) { index, item in
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(item.category ?? "").font(.subheadline)
                                    if let memo = item.memo, !memo.isEmpty {
                                        Text(memo).font(.caption).foregroundStyle(AppTheme.secondaryText)
                                    }
                                }
                                Spacer()
                                Text("\(Int(item.amount).formatted())원").font(.subheadline.weight(.semibold))
                            }
                            if index != claim.items.count - 1 { Divider() }
                        }
                    }

                    if claim.status == "rejected", let reason = claim.rejectReason, !reason.isEmpty {
                        AppCard(title: "반려 사유") {
                            Text(reason).font(.subheadline).foregroundStyle(AppTheme.danger)
                        }
                    }
                    if claim.status == "paid" {
                        AppCard(title: "지급 정보") {
                            LabeledContent("지급일", value: claim.paidAt ?? "-")
                            LabeledContent("지급 방법", value: claim.payMethod ?? "-")
                            if let voucherNo = claim.voucherNo, !voucherNo.isEmpty {
                                LabeledContent("전표번호", value: voucherNo)
                            }
                        }
                    }

                    if claim.status == "pending" {
                        AppCard(title: "반려 사유 (반려 시 필수)") {
                            TextField("반려 사유", text: $rejectReason, axis: .vertical)
                                .appFieldStyle()
                            HStack(spacing: 10) {
                                Button("승인") { Task { await approve() } }
                                    .buttonStyle(AppPrimaryButtonStyle(isDisabled: isSaving))
                                    .disabled(isSaving)
                                Button("반려") { Task { await reject() } }
                                    .buttonStyle(.bordered)
                                    .tint(AppTheme.danger)
                                    .disabled(isSaving || rejectReason.trimmingCharacters(in: .whitespaces).isEmpty)
                            }
                        }
                    } else if claim.status == "approved" {
                        Button("지급 처리") { showingPay = true }
                            .buttonStyle(AppPrimaryButtonStyle(isDisabled: isSaving))
                            .disabled(isSaving)
                    }

                    if let errorMessage {
                        AppCard { Text(errorMessage).font(.footnote).foregroundStyle(AppTheme.danger) }
                    }
                }
                .navigationTitle("경비청구 상세")
                .sheet(isPresented: $showingPay) {
                    ExpensePayView(store: store, claim: claim) {
                        onChanged()
                    }
                    .environmentObject(settings)
                    .environmentObject(session)
                }
            } else {
                EmptyState(message: "청구 내역을 찾을 수 없습니다.")
            }
        }
    }

    private func approve() async {
        guard let admin = session.currentEmployee else { return }
        isSaving = true
        defer { isSaving = false }
        store.approveExpenseClaim(id: claimId, adminName: admin.name)
        let saved = await store.save(client: client, session: session)
        if saved {
            onChanged()
        } else {
            errorMessage = store.lastError ?? "저장에 실패했습니다."
        }
    }

    private func reject() async {
        guard let admin = session.currentEmployee else { return }
        let reason = rejectReason.trimmingCharacters(in: .whitespaces)
        guard !reason.isEmpty else { return }
        isSaving = true
        defer { isSaving = false }
        store.rejectExpenseClaim(id: claimId, adminName: admin.name, reason: reason)
        let saved = await store.save(client: client, session: session)
        if saved {
            onChanged()
        } else {
            errorMessage = store.lastError ?? "저장에 실패했습니다."
        }
    }
}

/// index.html의 openExpensePayModal()/payExpenseClaim()을 옮겼다. 전표 자동 생성은 관리자
/// 전용 엔드포인트(POST /api/accounting/vouchers)를 쓰며, 전표 생성이 실패하면 지급 처리
/// 자체를 취소한다(회계 기록 없이 "지급완료"로만 표시되는 불일치를 막기 위해 — 웹 앱과 동일).
@MainActor
private struct ExpensePayView: View {
    @EnvironmentObject private var settings: AppSettings
    @EnvironmentObject private var session: SessionStore
    @ObservedObject var store: HRDataStore
    let claim: ExpenseClaim
    let onSaved: () -> Void
    @Environment(\.dismiss) private var dismiss

    private let payMethods = ["계좌이체", "급여 합산", "현금"]

    @State private var payDate = Date()
    @State private var payMethod = "계좌이체"
    @State private var makeVoucher = true
    @State private var accounts: [Account] = []
    @State private var debitAccountId = ""
    @State private var creditAccountId = ""
    @State private var isLoadingAccounts = false
    @State private var isSaving = false
    @State private var errorMessage: String?

    private var client: APIClient { APIClient(settings: settings) }
    private var dateFormatter: DateFormatter {
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; return f
    }
    private var expenseAccounts: [Account] { accounts.filter { $0.type == "expense" && $0.active != false } }
    private var assetAccounts: [Account] { accounts.filter { $0.type == "asset" && $0.active != false } }
    private var canMakeVoucher: Bool { !expenseAccounts.isEmpty && !assetAccounts.isEmpty }

    var body: some View {
        NavigationStack {
            Form {
                Section("지급 정보") {
                    DatePicker("지급일", selection: $payDate, displayedComponents: .date)
                    Picker("지급 방법", selection: $payMethod) {
                        ForEach(payMethods, id: \.self) { Text($0) }
                    }
                    LabeledContent("금액", value: "\(Int(claim.total).formatted())원")
                }
                if isLoadingAccounts {
                    Section { ProgressView() }
                } else if canMakeVoucher {
                    Section {
                        Toggle("회계 전표 자동 생성 (임시 상태로 생성됨)", isOn: $makeVoucher)
                        if makeVoucher {
                            Picker("차변(비용) 계정", selection: $debitAccountId) {
                                ForEach(expenseAccounts) { Text("\($0.code) \($0.name)").tag($0.id) }
                            }
                            Picker("대변(지급) 계정", selection: $creditAccountId) {
                                ForEach(assetAccounts) { Text("\($0.code) \($0.name)").tag($0.id) }
                            }
                        }
                    }
                } else {
                    Section {
                        Text("※ 회계 전표 자동 생성은 비용/자산 계정과목이 등록되어 있어야 활성화됩니다.")
                            .font(.caption)
                            .foregroundStyle(AppTheme.secondaryText)
                    }
                }
                if let errorMessage {
                    Section { Text(errorMessage).font(.footnote).foregroundStyle(.red) }
                }
            }
            .navigationTitle("지급 처리")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("취소") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("지급 완료") { Task { await submit() } }
                        .disabled(isSaving)
                }
            }
            .task { await loadAccounts() }
        }
    }

    private func loadAccounts() async {
        guard let token = session.token else { return }
        isLoadingAccounts = true
        defer { isLoadingAccounts = false }
        do {
            accounts = try await client.fetchAccounts(token: token)
            debitAccountId = expenseAccounts.first?.id ?? ""
            creditAccountId = assetAccounts.first(where: { $0.name.contains("보통예금") || $0.name.contains("현금") })?.id
                ?? assetAccounts.first?.id ?? ""
        } catch {
            if case APIError.serverError(401, _) = error {
                session.handleUnauthorized()
            }
            // 계정과목 조회 실패는 전표 생성 체크박스만 비활성화되고 지급 처리 자체는
            // (전표 없이) 계속 가능해야 하므로 errorMessage로 막지 않는다.
        }
    }

    private func submit() async {
        guard let admin = session.currentEmployee, let token = session.token else { return }
        isSaving = true
        defer { isSaving = false }

        var voucherId: String?
        var voucherNo: String?
        if makeVoucher && canMakeVoucher {
            guard !debitAccountId.isEmpty, !creditAccountId.isEmpty else {
                errorMessage = "차변/대변 계정을 선택하세요."
                return
            }
            do {
                let voucher = try await client.createVoucher(
                    date: dateFormatter.string(from: payDate),
                    description: "경비정산 - \(claim.empName ?? "") \(claim.title)",
                    partner: claim.empName ?? "",
                    lines: [
                        APIClient.NewVoucherLine(accountId: debitAccountId, debit: claim.total, credit: 0, memo: claim.title),
                        APIClient.NewVoucherLine(accountId: creditAccountId, debit: 0, credit: claim.total, memo: "경비지급(\(payMethod))"),
                    ],
                    role: admin.role ?? "admin", user: admin.name, token: token
                )
                voucherId = voucher.id
                voucherNo = voucher.voucherNo ?? "(임시)"
            } catch {
                if case APIError.serverError(401, _) = error {
                    session.handleUnauthorized()
                    return
                }
                errorMessage = "전표 생성에 실패했습니다: \(error.localizedDescription) — 지급 처리가 취소되었습니다. 다시 시도하거나 전표 자동 생성을 해제하고 재시도하세요."
                return
            }
        }

        store.markExpensePaid(
            id: claim.id, payDate: dateFormatter.string(from: payDate), payMethod: payMethod,
            adminName: admin.name, voucherId: voucherId, voucherNo: voucherNo
        )
        let saved = await store.save(client: client, session: session)
        if saved {
            onSaved()
            dismiss()
        } else {
            errorMessage = store.lastError ?? "저장에 실패했습니다."
        }
    }
}
