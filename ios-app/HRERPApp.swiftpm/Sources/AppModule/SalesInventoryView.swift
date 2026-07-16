import SwiftUI

@MainActor
struct SalesInventoryView: View {
    @EnvironmentObject private var settings: AppSettings
    @EnvironmentObject private var session: SessionStore

    private enum Tab: String, CaseIterable, Identifiable {
        case items = "품목"
        case quotations = "견적서"
        case purchaseOrders = "발주서"
        case stock = "재고현황"
        var id: String { rawValue }
    }

    @State private var tab: Tab = .items
    @State private var items: [InventoryItem] = []
    @State private var locations: [WarehouseLocation] = []
    @State private var quotations: [TradeDocument] = []
    @State private var purchaseOrders: [TradeDocument] = []
    @State private var stock: [StockLevel] = []
    @State private var isLoading = false
    @State private var errorMessage: String?

    private var client: APIClient { APIClient(settings: settings) }
    private var itemName: [String: String] { Dictionary(uniqueKeysWithValues: items.map { ($0.id, $0.name) }) }
    private var locationName: [String: String] { Dictionary(uniqueKeysWithValues: locations.map { ($0.id, $0.name) }) }

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
            case .items:
                if items.isEmpty && !isLoading { EmptyState(message: "등록된 품목이 없습니다.") }
                ForEach(items) { item in
                    AppCard {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("\(item.code)  \(item.name)").font(.subheadline.weight(.semibold))
                                Text(item.category ?? "").font(.caption).foregroundStyle(AppTheme.secondaryText)
                            }
                            Spacer()
                            Text(item.unit ?? "EA").font(.caption).foregroundStyle(AppTheme.secondaryText)
                        }
                    }
                }
            case .quotations:
                tradeDocList(quotations, emptyMessage: "등록된 견적서가 없습니다.")
            case .purchaseOrders:
                tradeDocList(purchaseOrders, emptyMessage: "등록된 발주서가 없습니다.")
            case .stock:
                if stock.isEmpty && !isLoading { EmptyState(message: "재고 이력이 없습니다.") }
                ForEach(stock) { level in
                    AppCard {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(itemName[level.itemId] ?? level.itemId).font(.subheadline.weight(.semibold))
                                Text(locationName[level.locationId] ?? level.locationId)
                                    .font(.caption)
                                    .foregroundStyle(AppTheme.secondaryText)
                            }
                            Spacer()
                            Text("\(Int(level.qty).formatted())")
                                .font(.subheadline.weight(.bold))
                                .foregroundStyle(level.qty <= 0 ? AppTheme.danger : AppTheme.primaryText)
                        }
                    }
                }
            }
        }
        .navigationTitle("영업/재고")
        .task { await load() }
        .refreshable { await load() }
    }

    @ViewBuilder
    private func tradeDocList(_ docs: [TradeDocument], emptyMessage: String) -> some View {
        if docs.isEmpty && !isLoading { EmptyState(message: emptyMessage) }
        ForEach(docs) { doc in
            AppCard {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(doc.partnerName).font(.subheadline.weight(.semibold))
                        Text("\(doc.date) · \(doc.docNo ?? "번호 미발행")")
                            .font(.caption)
                            .foregroundStyle(AppTheme.secondaryText)
                    }
                    Spacer()
                    VStack(alignment: .trailing, spacing: 2) {
                        Text("\(Int(doc.grandTotal).formatted())원").font(.subheadline.weight(.bold))
                        StatusPill(status: doc.status)
                    }
                }
            }
        }
    }

    private func load() async {
        guard let token = session.token else { return }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            async let i = client.fetchItems(token: token)
            async let l = client.fetchLocations(token: token)
            async let q = client.fetchQuotations(token: token)
            async let p = client.fetchPurchaseOrders(token: token)
            async let s = client.fetchStock(token: token)
            (items, locations, quotations, purchaseOrders, stock) = try await (i, l, q, p, s)
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
