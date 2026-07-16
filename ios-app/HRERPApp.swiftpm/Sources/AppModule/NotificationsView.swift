import SwiftUI

/// 실제 푸시 알림(APNs) 인프라는 없다 — server.js에 그런 엔드포인트 자체가 없기 때문이다.
/// 대신 이미 갖고 있는 데이터에서 "지금 확인해야 할 것"을 모아 보여주는 인앱 알림 피드다:
/// 내가 처리할 결재, 대기중인 내 경비청구, 안전재고 미만 품목(재고관리 안전재고 부족 알림과
/// 동일한 조건). 새 데이터가 생겨도 실시간으로 밀어주지 않고 새로고침해야 갱신된다.
@MainActor
struct NotificationsView: View {
    @EnvironmentObject private var settings: AppSettings
    @EnvironmentObject private var session: SessionStore
    @ObservedObject var store: HRDataStore
    let reload: () async -> Void

    @State private var lowStockItems: [(item: InventoryItem, qty: Double)] = []
    @State private var isLoadingStock = false
    @State private var errorMessage: String?

    private var client: APIClient { APIClient(settings: settings) }

    private var pendingApprovals: [ApprovalDocSummary] {
        guard let empId = session.currentEmployee?.id else { return [] }
        return store.approvalDocs
            .filter { $0.status == "in_progress" && $0.approvers.contains { $0.empId == empId && $0.status == "pending" } }
            .sorted { $0.createdAt > $1.createdAt }
    }

    private var pendingExpenses: [ExpenseClaim] {
        guard let empId = session.currentEmployee?.id else { return [] }
        return store.expenseClaims.filter { $0.empId == empId && $0.status == "pending" }
    }

    private var totalCount: Int { pendingApprovals.count + pendingExpenses.count + lowStockItems.count }

    var body: some View {
        AppScreen {
            if totalCount == 0 && !isLoadingStock {
                EmptyState(message: "새로운 알림이 없습니다.")
            }

            if !pendingApprovals.isEmpty {
                AppCard(title: "결재 대기 (\(pendingApprovals.count))") {
                    ForEach(pendingApprovals) { doc in
                        HStack {
                            Image(systemName: "checkmark.seal").foregroundStyle(AppTheme.warning)
                            Text(doc.title).font(.subheadline)
                            Spacer()
                            Text(doc.createdAt.prefix(10)).font(.caption).foregroundStyle(AppTheme.secondaryText)
                        }
                        if doc.id != pendingApprovals.last?.id { Divider() }
                    }
                }
            }

            if !pendingExpenses.isEmpty {
                AppCard(title: "경비청구 승인 대기 (\(pendingExpenses.count))") {
                    ForEach(pendingExpenses) { claim in
                        HStack {
                            Image(systemName: "wonsign.circle").foregroundStyle(AppTheme.warning)
                            Text(claim.title).font(.subheadline)
                            Spacer()
                            Text("\(Int(claim.total).formatted())원").font(.caption).foregroundStyle(AppTheme.secondaryText)
                        }
                        if claim.id != pendingExpenses.last?.id { Divider() }
                    }
                }
            }

            if !lowStockItems.isEmpty {
                AppCard(title: "안전재고 부족 (\(lowStockItems.count))") {
                    ForEach(Array(lowStockItems.enumerated()), id: \.offset) { index, entry in
                        HStack {
                            Image(systemName: "exclamationmark.triangle").foregroundStyle(AppTheme.danger)
                            Text(entry.item.name).font(.subheadline)
                            Spacer()
                            Text("\(Int(entry.qty).formatted())개").font(.caption).foregroundStyle(AppTheme.danger)
                        }
                        if index != lowStockItems.count - 1 { Divider() }
                    }
                }
            }

            if let errorMessage {
                AppCard { Text(errorMessage).font(.footnote).foregroundStyle(AppTheme.danger) }
            }
        }
        .navigationTitle("알림")
        .task { await loadLowStock() }
        .refreshable {
            await reload()
            await loadLowStock()
        }
    }

    private func loadLowStock() async {
        guard let token = session.token else { return }
        isLoadingStock = true
        errorMessage = nil
        defer { isLoadingStock = false }
        do {
            async let itemsTask = client.fetchItems(token: token)
            async let stockTask = client.fetchStock(token: token)
            let (items, stock) = try await (itemsTask, stockTask)

            let qtyByItem = Dictionary(grouping: stock, by: { $0.itemId })
                .mapValues { $0.reduce(0) { $0 + $1.qty } }

            lowStockItems = items.compactMap { item in
                guard let safetyStock = item.safetyStock, safetyStock > 0 else { return nil }
                let qty = qtyByItem[item.id] ?? 0
                guard qty < safetyStock else { return nil }
                return (item, qty)
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
