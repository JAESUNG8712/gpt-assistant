import SwiftUI

private let accountTypes = ["asset", "liability", "equity", "revenue", "expense"]
private let accountTypeLabels = [
    "asset": "자산", "liability": "부채", "equity": "자본", "revenue": "수익", "expense": "비용",
]

@MainActor
struct AccountingView: View {
    @EnvironmentObject private var settings: AppSettings
    @EnvironmentObject private var session: SessionStore

    private enum Tab: String, CaseIterable, Identifiable {
        case accounts = "계정과목"
        case vouchers = "전표"
        var id: String { rawValue }
    }

    @State private var tab: Tab = .accounts
    @State private var accounts: [Account] = []
    @State private var vouchers: [Voucher] = []
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var editingAccount: Account?
    @State private var showingNewAccount = false
    @State private var creatingVoucher = false
    @State private var selectedVoucher: Voucher?

    private var client: APIClient { APIClient(settings: settings) }
    private var isAdmin: Bool { session.currentEmployee?.role == "admin" }

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
            case .accounts:
                if accounts.isEmpty && !isLoading {
                    EmptyState(message: "등록된 계정과목이 없습니다.")
                }
                ForEach(accounts) { account in
                    AppCard {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("\(account.code)  \(account.name)").font(.subheadline.weight(.semibold))
                                Text([accountTypeLabels[account.type] ?? account.type, account.category].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                                    .font(.caption)
                                    .foregroundStyle(AppTheme.secondaryText)
                            }
                            Spacer()
                            if account.active == false {
                                Text("비활성")
                                    .font(.caption.weight(.semibold))
                                    .padding(.horizontal, 8)
                                    .padding(.vertical, 3)
                                    .background(AppTheme.secondaryText.opacity(0.12))
                                    .foregroundStyle(AppTheme.secondaryText)
                                    .clipShape(Capsule())
                            }
                        }
                    }
                    .contentShape(Rectangle())
                    .onTapGesture { if isAdmin { editingAccount = account } }
                }
            case .vouchers:
                if vouchers.isEmpty && !isLoading {
                    EmptyState(message: "등록된 전표가 없습니다.")
                }
                ForEach(vouchers) { voucher in
                    AppCard {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(voucher.description?.isEmpty == false ? voucher.description! : "(설명 없음)")
                                    .font(.subheadline.weight(.semibold))
                                Text("\(voucher.date) · \(voucher.partner ?? "")")
                                    .font(.caption)
                                    .foregroundStyle(AppTheme.secondaryText)
                            }
                            Spacer()
                            VStack(alignment: .trailing, spacing: 2) {
                                Text("\(Int(voucher.amount).formatted())원").font(.subheadline.weight(.bold))
                                StatusPill(status: voucher.status)
                            }
                        }
                    }
                    .contentShape(Rectangle())
                    .onTapGesture { if isAdmin { selectedVoucher = voucher } }
                }
            }
        }
        .navigationTitle("회계")
        .task { await load() }
        .refreshable { await load() }
        .toolbar {
            if isAdmin {
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        if tab == .accounts { showingNewAccount = true } else { creatingVoucher = true }
                    } label: {
                        Image(systemName: "plus")
                    }
                }
            }
        }
        .sheet(isPresented: $showingNewAccount) {
            AccountEditView(existing: nil) { Task { await load() } }
                .environmentObject(settings)
                .environmentObject(session)
        }
        .sheet(item: $editingAccount) { account in
            AccountEditView(existing: account) { Task { await load() } }
                .environmentObject(settings)
                .environmentObject(session)
        }
        .sheet(isPresented: $creatingVoucher) {
            NewVoucherView(accounts: accounts) { Task { await load() } }
                .environmentObject(settings)
                .environmentObject(session)
        }
        .sheet(item: $selectedVoucher) { voucher in
            VoucherDetailView(voucher: voucher, accounts: accounts) { Task { await load() } }
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
            async let a = client.fetchAccounts(token: token)
            async let v = client.fetchVouchers(token: token)
            (accounts, vouchers) = try await (a, v)
        } catch {
            if case APIError.serverError(401, _) = error {
                session.handleUnauthorized()
            } else {
                errorMessage = error.localizedDescription
            }
        }
    }
}

/// index.html의 계정과목 등록/수정 폼을 옮겼다. `existing`이 있으면 수정(같은 id로 upsert),
/// 없으면 신규 등록(서버가 새 id 발급).
@MainActor
private struct AccountEditView: View {
    @EnvironmentObject private var settings: AppSettings
    @EnvironmentObject private var session: SessionStore
    @Environment(\.dismiss) private var dismiss
    let existing: Account?
    let onSaved: () -> Void

    @State private var code: String
    @State private var name: String
    @State private var type: String
    @State private var category: String
    @State private var active: Bool
    @State private var isSaving = false
    @State private var errorMessage: String?

    private var client: APIClient { APIClient(settings: settings) }

    init(existing: Account?, onSaved: @escaping () -> Void) {
        self.existing = existing
        self.onSaved = onSaved
        _code = State(initialValue: existing?.code ?? "")
        _name = State(initialValue: existing?.name ?? "")
        _type = State(initialValue: existing?.type ?? "asset")
        _category = State(initialValue: existing?.category ?? "")
        _active = State(initialValue: existing?.active ?? true)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("계정과목") {
                    TextField("계정코드 *", text: $code)
                    TextField("계정명 *", text: $name)
                    Picker("구분 *", selection: $type) {
                        ForEach(accountTypes, id: \.self) { Text(accountTypeLabels[$0] ?? $0).tag($0) }
                    }
                    TextField("분류 (선택)", text: $category)
                    Toggle("사용", isOn: $active)
                }
                if let errorMessage {
                    Section { Text(errorMessage).font(.footnote).foregroundStyle(.red) }
                }
            }
            .navigationTitle(existing == nil ? "계정과목 등록" : "계정과목 수정")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("취소") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("저장") { Task { await submit() } }
                        .disabled(isSaving || code.trimmingCharacters(in: .whitespaces).isEmpty || name.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
    }

    private func submit() async {
        guard let admin = session.currentEmployee, let token = session.token else { return }
        isSaving = true
        defer { isSaving = false }
        do {
            _ = try await client.saveAccount(
                id: existing?.id, code: code, name: name, type: type,
                category: category, active: active, user: admin.name, token: token
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

/// index.html의 전표 작성 폼(차변/대변 라인 여러 건)을 옮겼다. 생성된 전표는 항상 "임시(draft)"
/// 상태이며, 확정(post)해야 정식 전표번호가 붙는다 — VoucherDetailView에서 확정/취소/삭제한다.
@MainActor
private struct NewVoucherView: View {
    @EnvironmentObject private var settings: AppSettings
    @EnvironmentObject private var session: SessionStore
    @Environment(\.dismiss) private var dismiss
    let accounts: [Account]
    let onSaved: () -> Void

    private struct DraftLine: Identifiable {
        let id = UUID()
        var accountId = ""
        var debit: Double = 0
        var credit: Double = 0
        var memo = ""
    }

    @State private var date = Date()
    @State private var description = ""
    @State private var partner = ""
    @State private var lines: [DraftLine] = [DraftLine(), DraftLine()]
    @State private var isSaving = false
    @State private var errorMessage: String?

    private var client: APIClient { APIClient(settings: settings) }
    private var activeAccounts: [Account] { accounts.filter { $0.active != false } }
    private var debitTotal: Double { lines.reduce(0) { $0 + $1.debit } }
    private var creditTotal: Double { lines.reduce(0) { $0 + $1.credit } }
    private var dateFormatter: DateFormatter {
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; return f
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("전표 정보") {
                    DatePicker("전표일자 *", selection: $date, displayedComponents: .date)
                    TextField("적요", text: $description)
                    TextField("거래처", text: $partner)
                }
                Section("차변/대변 라인") {
                    ForEach($lines) { $line in
                        VStack(alignment: .leading, spacing: 6) {
                            Picker("계정", selection: $line.accountId) {
                                Text("선택").tag("")
                                ForEach(activeAccounts) { Text("\($0.code) \($0.name)").tag($0.id) }
                            }
                            HStack {
                                TextField("차변", value: $line.debit, format: .number).keyboardType(.numberPad)
                                TextField("대변", value: $line.credit, format: .number).keyboardType(.numberPad)
                            }
                            TextField("메모 (선택)", text: $line.memo)
                        }
                        .padding(.vertical, 4)
                    }
                    .onDelete { lines.remove(atOffsets: $0) }
                    Button("+ 라인 추가") { lines.append(DraftLine()) }
                }
                Section {
                    LabeledContent("차변 합계", value: "\(Int(debitTotal).formatted())원")
                    LabeledContent("대변 합계", value: "\(Int(creditTotal).formatted())원")
                    if debitTotal != creditTotal {
                        Text("차변과 대변 합계가 일치해야 합니다.").font(.caption).foregroundStyle(AppTheme.danger)
                    }
                }
                if let errorMessage {
                    Section { Text(errorMessage).font(.footnote).foregroundStyle(.red) }
                }
            }
            .navigationTitle("전표 작성")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("취소") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("저장") { Task { await submit() } }
                        .disabled(isSaving || debitTotal <= 0 || debitTotal != creditTotal || lines.contains { $0.accountId.isEmpty })
                }
            }
        }
    }

    private func submit() async {
        guard let admin = session.currentEmployee, let token = session.token else { return }
        isSaving = true
        defer { isSaving = false }
        do {
            _ = try await client.createVoucher(
                date: dateFormatter.string(from: date), description: description, partner: partner,
                lines: lines.map { APIClient.NewVoucherLine(accountId: $0.accountId, debit: $0.debit, credit: $0.credit, memo: $0.memo) },
                role: admin.role ?? "admin", user: admin.name, token: token
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
private struct VoucherDetailView: View {
    @EnvironmentObject private var settings: AppSettings
    @EnvironmentObject private var session: SessionStore
    @Environment(\.dismiss) private var dismiss
    let voucher: Voucher
    let accounts: [Account]
    let onChanged: () -> Void

    @State private var voidReason = ""
    @State private var isSaving = false
    @State private var errorMessage: String?

    private var client: APIClient { APIClient(settings: settings) }
    private var accountLabel: [String: String] {
        Dictionary(uniqueKeysWithValues: accounts.map { ($0.id, "\($0.code) \($0.name)") })
    }

    var body: some View {
        NavigationStack {
            AppScreen {
                AppCard {
                    LabeledContent("적요", value: voucher.description?.isEmpty == false ? voucher.description! : "-")
                    LabeledContent("전표일자", value: voucher.date)
                    LabeledContent("거래처", value: voucher.partner?.isEmpty == false ? voucher.partner! : "-")
                    LabeledContent("상태") { StatusPill(status: voucher.status) }
                    if let voucherNo = voucher.voucherNo, !voucherNo.isEmpty {
                        LabeledContent("전표번호", value: voucherNo)
                    }
                }
                AppCard(title: "라인") {
                    ForEach(Array(voucher.lines.enumerated()), id: \.offset) { index, line in
                        HStack {
                            Text(accountLabel[line.accountId] ?? line.accountId).font(.subheadline)
                            Spacer()
                            if line.debit > 0 {
                                Text("차변 \(Int(line.debit).formatted())원").font(.caption)
                            }
                            if line.credit > 0 {
                                Text("대변 \(Int(line.credit).formatted())원").font(.caption)
                            }
                        }
                        if index != voucher.lines.count - 1 { Divider() }
                    }
                }

                if voucher.status == "draft" {
                    HStack(spacing: 10) {
                        Button("확정") { Task { await post() } }
                            .buttonStyle(AppPrimaryButtonStyle(isDisabled: isSaving))
                            .disabled(isSaving)
                        Button("삭제", role: .destructive) { Task { await deleteDraft() } }
                            .buttonStyle(.bordered)
                            .tint(AppTheme.danger)
                            .disabled(isSaving)
                    }
                } else if voucher.status == "posted" {
                    AppCard(title: "전표 취소") {
                        TextField("취소 사유 (필수)", text: $voidReason, axis: .vertical)
                            .appFieldStyle()
                        Button("전표 취소") { Task { await void() } }
                            .buttonStyle(.bordered)
                            .tint(AppTheme.danger)
                            .disabled(isSaving || voidReason.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                }

                if let errorMessage {
                    AppCard { Text(errorMessage).font(.footnote).foregroundStyle(AppTheme.danger) }
                }
            }
            .navigationTitle("전표 상세")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("닫기") { dismiss() }
                }
            }
        }
    }

    private func post() async {
        guard let admin = session.currentEmployee, let token = session.token else { return }
        isSaving = true
        defer { isSaving = false }
        do {
            _ = try await client.postVoucher(id: voucher.id, user: admin.name, token: token)
            onChanged()
            dismiss()
        } catch {
            if case APIError.serverError(401, _) = error {
                session.handleUnauthorized()
            } else {
                errorMessage = error.localizedDescription
            }
        }
    }

    private func void() async {
        guard let admin = session.currentEmployee, let token = session.token else { return }
        let reason = voidReason.trimmingCharacters(in: .whitespaces)
        guard !reason.isEmpty else { return }
        isSaving = true
        defer { isSaving = false }
        do {
            _ = try await client.voidVoucher(id: voucher.id, reason: reason, user: admin.name, token: token)
            onChanged()
            dismiss()
        } catch {
            if case APIError.serverError(401, _) = error {
                session.handleUnauthorized()
            } else {
                errorMessage = error.localizedDescription
            }
        }
    }

    private func deleteDraft() async {
        guard let token = session.token else { return }
        isSaving = true
        defer { isSaving = false }
        do {
            try await client.deleteVoucher(id: voucher.id, token: token)
            onChanged()
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
