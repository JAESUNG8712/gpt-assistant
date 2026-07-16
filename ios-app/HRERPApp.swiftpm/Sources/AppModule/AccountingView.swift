import SwiftUI

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

    private var client: APIClient { APIClient(settings: settings) }

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
                                Text([account.type, account.category].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
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
                }
            }
        }
        .navigationTitle("회계")
        .task { await load() }
        .refreshable { await load() }
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
