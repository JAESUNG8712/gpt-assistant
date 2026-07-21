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
    @State private var showingNewItem = false
    @State private var showingNewQuotation = false
    @State private var showingNewPurchaseOrder = false
    @State private var showingStockAdjust = false

    private var client: APIClient { APIClient(settings: settings) }
    private var isAdmin: Bool { session.currentEmployee?.role == "admin" }
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
        .toolbar {
            if isAdmin {
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        switch tab {
                        case .items: showingNewItem = true
                        case .quotations: showingNewQuotation = true
                        case .purchaseOrders: showingNewPurchaseOrder = true
                        case .stock: showingStockAdjust = true
                        }
                    } label: {
                        Image(systemName: "plus")
                    }
                }
            }
        }
        .sheet(isPresented: $showingNewItem) {
            NewItemView { Task { await load() } }
                .environmentObject(settings)
                .environmentObject(session)
        }
        .sheet(isPresented: $showingNewQuotation) {
            NewQuotationView(items: items, locations: locations) { Task { await load() } }
                .environmentObject(settings)
                .environmentObject(session)
        }
        .sheet(isPresented: $showingNewPurchaseOrder) {
            NewPurchaseOrderView(items: items, locations: locations) { Task { await load() } }
                .environmentObject(settings)
                .environmentObject(session)
        }
        .sheet(isPresented: $showingStockAdjust) {
            StockAdjustView(items: items, locations: locations) { Task { await load() } }
                .environmentObject(settings)
                .environmentObject(session)
        }
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
            if case APIError.serverError(401, _) = error {
                session.handleUnauthorized()
            } else {
                errorMessage = error.localizedDescription
            }
        }
    }
}

/// index.html의 품목 등록 폼을 옮겼다. 등록/수정 모두 같은 엔드포인트(id 없으면 신규)라
/// 웹처럼 목록에서 탭해 수정하는 것도 같은 패턴으로 확장 가능하지만, 이번엔 신규 등록만 구현.
@MainActor
private struct NewItemView: View {
    @EnvironmentObject private var settings: AppSettings
    @EnvironmentObject private var session: SessionStore
    @Environment(\.dismiss) private var dismiss
    let onSaved: () -> Void

    @State private var code = ""
    @State private var name = ""
    @State private var unit = "EA"
    @State private var category = ""
    @State private var safetyStockText = ""
    @State private var unitCostText = ""
    @State private var isSaving = false
    @State private var errorMessage: String?

    private var client: APIClient { APIClient(settings: settings) }

    var body: some View {
        NavigationStack {
            Form {
                Section("품목") {
                    TextField("품목코드 *", text: $code)
                    TextField("품목명 *", text: $name)
                    TextField("단위 (예: EA, BOX)", text: $unit)
                    TextField("분류 (선택)", text: $category)
                }
                Section("재고 기준") {
                    TextField("안전재고", text: $safetyStockText).keyboardType(.numberPad)
                    TextField("단가(원)", text: $unitCostText).keyboardType(.numberPad)
                }
                if let errorMessage {
                    Section { Text(errorMessage).font(.footnote).foregroundStyle(.red) }
                }
            }
            .navigationTitle("품목 등록")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("취소") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("등록") { Task { await submit() } }
                        .disabled(isSaving || code.trimmingCharacters(in: .whitespaces).isEmpty || name.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
    }

    private func submit() async {
        guard let token = session.token else { return }
        isSaving = true
        defer { isSaving = false }
        do {
            _ = try await client.createItem(
                code: code, name: name, unit: unit.isEmpty ? "EA" : unit, category: category,
                safetyStock: Double(safetyStockText) ?? 0, unitCost: Double(unitCostText) ?? 0,
                active: true, token: token
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
private struct StockAdjustView: View {
    @EnvironmentObject private var settings: AppSettings
    @EnvironmentObject private var session: SessionStore
    @Environment(\.dismiss) private var dismiss
    let items: [InventoryItem]
    let locations: [WarehouseLocation]
    let onSaved: () -> Void

    @State private var itemId = ""
    @State private var locationId = ""
    @State private var type = "in"
    @State private var qtyText = ""
    @State private var memo = ""
    @State private var isSaving = false
    @State private var errorMessage: String?

    private var client: APIClient { APIClient(settings: settings) }

    var body: some View {
        NavigationStack {
            Form {
                Section("재고 조정") {
                    Picker("품목", selection: $itemId) {
                        Text("선택").tag("")
                        ForEach(items) { Text("\($0.code) \($0.name)").tag($0.id) }
                    }
                    Picker("위치", selection: $locationId) {
                        Text("선택").tag("")
                        ForEach(locations) { Text($0.name).tag($0.id) }
                    }
                    Picker("구분", selection: $type) {
                        Text("입고").tag("in")
                        Text("출고").tag("out")
                    }
                    TextField("수량 *", text: $qtyText).keyboardType(.numberPad)
                    TextField("메모 (선택)", text: $memo)
                }
                if let errorMessage {
                    Section { Text(errorMessage).font(.footnote).foregroundStyle(.red) }
                }
            }
            .navigationTitle("재고 조정")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("취소") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("저장") { Task { await submit() } }
                        .disabled(isSaving || itemId.isEmpty || locationId.isEmpty || (Double(qtyText) ?? 0) <= 0)
                }
            }
        }
    }

    private func submit() async {
        guard let admin = session.currentEmployee, let token = session.token, let qty = Double(qtyText), qty > 0 else { return }
        isSaving = true
        defer { isSaving = false }
        do {
            try await client.adjustStock(itemId: itemId, locationId: locationId, type: type, qty: qty, memo: memo, user: admin.name, token: token)
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

private struct DraftDocLine: Identifiable {
    let id = UUID()
    var itemId = ""
    var qty: Double = 1
    var unitPrice: Double = 0
}

/// index.html의 견적서 신규 작성 폼을 옮겼다. 서버가 지원하는 송부/수락/출고 등 이후
/// 상태 전이 단계는 범위 밖 — README 참고.
@MainActor
private struct NewQuotationView: View {
    @EnvironmentObject private var settings: AppSettings
    @EnvironmentObject private var session: SessionStore
    @Environment(\.dismiss) private var dismiss
    let items: [InventoryItem]
    let locations: [WarehouseLocation]
    let onSaved: () -> Void

    @State private var date = Date()
    @State private var validUntil = Date()
    @State private var partnerName = ""
    @State private var locationId = ""
    @State private var memo = ""
    @State private var lines: [DraftDocLine] = [DraftDocLine()]
    @State private var isSaving = false
    @State private var errorMessage: String?

    private var client: APIClient { APIClient(settings: settings) }
    private var dateFormatter: DateFormatter {
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; return f
    }
    private var itemName: [String: String] { Dictionary(uniqueKeysWithValues: items.map { ($0.id, $0.name) }) }

    var body: some View {
        NavigationStack {
            Form {
                Section("견적 정보") {
                    DatePicker("견적일자 *", selection: $date, displayedComponents: .date)
                    DatePicker("유효기한", selection: $validUntil, displayedComponents: .date)
                    TextField("거래처명 *", text: $partnerName)
                    Picker("출고 위치 (선택)", selection: $locationId) {
                        Text("선택 안 함").tag("")
                        ForEach(locations) { Text($0.name).tag($0.id) }
                    }
                    TextField("메모", text: $memo)
                }
                Section("품목") {
                    ForEach($lines) { $line in
                        VStack(alignment: .leading, spacing: 6) {
                            Picker("품목", selection: $line.itemId) {
                                Text("선택").tag("")
                                ForEach(items) { Text("\($0.code) \($0.name)").tag($0.id) }
                            }
                            HStack {
                                TextField("수량", value: $line.qty, format: .number).keyboardType(.numberPad)
                                TextField("단가", value: $line.unitPrice, format: .number).keyboardType(.numberPad)
                            }
                        }
                        .padding(.vertical, 4)
                    }
                    .onDelete { lines.remove(atOffsets: $0) }
                    Button("+ 품목 추가") { lines.append(DraftDocLine()) }
                }
                if let errorMessage {
                    Section { Text(errorMessage).font(.footnote).foregroundStyle(.red) }
                }
            }
            .navigationTitle("견적서 작성")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("취소") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("저장") { Task { await submit() } }
                        .disabled(isSaving || partnerName.trimmingCharacters(in: .whitespaces).isEmpty || lines.contains { $0.itemId.isEmpty })
                }
            }
        }
    }

    private func submit() async {
        guard let admin = session.currentEmployee, let token = session.token else { return }
        isSaving = true
        defer { isSaving = false }
        do {
            _ = try await client.createQuotation(
                date: dateFormatter.string(from: date), validUntil: dateFormatter.string(from: validUntil),
                partnerName: partnerName, locationId: locationId.isEmpty ? nil : locationId,
                items: lines.map { APIClient.NewTradeDocLine(itemId: $0.itemId, name: itemName[$0.itemId] ?? "", qty: $0.qty, unitPrice: $0.unitPrice) },
                memo: memo, user: admin.name, token: token
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

/// index.html의 발주서 신규 작성 폼을 옮겼다. 견적서와 달리 입고 위치가 필수다.
@MainActor
private struct NewPurchaseOrderView: View {
    @EnvironmentObject private var settings: AppSettings
    @EnvironmentObject private var session: SessionStore
    @Environment(\.dismiss) private var dismiss
    let items: [InventoryItem]
    let locations: [WarehouseLocation]
    let onSaved: () -> Void

    @State private var date = Date()
    @State private var deliveryDate = Date()
    @State private var partnerName = ""
    @State private var locationId = ""
    @State private var memo = ""
    @State private var lines: [DraftDocLine] = [DraftDocLine()]
    @State private var isSaving = false
    @State private var errorMessage: String?

    private var client: APIClient { APIClient(settings: settings) }
    private var dateFormatter: DateFormatter {
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; return f
    }
    private var itemName: [String: String] { Dictionary(uniqueKeysWithValues: items.map { ($0.id, $0.name) }) }

    var body: some View {
        NavigationStack {
            Form {
                Section("발주 정보") {
                    DatePicker("발주일자 *", selection: $date, displayedComponents: .date)
                    DatePicker("입고 예정일", selection: $deliveryDate, displayedComponents: .date)
                    TextField("거래처명 *", text: $partnerName)
                    Picker("입고 위치 *", selection: $locationId) {
                        Text("선택").tag("")
                        ForEach(locations) { Text($0.name).tag($0.id) }
                    }
                    TextField("메모", text: $memo)
                }
                Section("품목") {
                    ForEach($lines) { $line in
                        VStack(alignment: .leading, spacing: 6) {
                            Picker("품목", selection: $line.itemId) {
                                Text("선택").tag("")
                                ForEach(items) { Text("\($0.code) \($0.name)").tag($0.id) }
                            }
                            HStack {
                                TextField("수량", value: $line.qty, format: .number).keyboardType(.numberPad)
                                TextField("단가", value: $line.unitPrice, format: .number).keyboardType(.numberPad)
                            }
                        }
                        .padding(.vertical, 4)
                    }
                    .onDelete { lines.remove(atOffsets: $0) }
                    Button("+ 품목 추가") { lines.append(DraftDocLine()) }
                }
                if let errorMessage {
                    Section { Text(errorMessage).font(.footnote).foregroundStyle(.red) }
                }
            }
            .navigationTitle("발주서 작성")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("취소") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("저장") { Task { await submit() } }
                        .disabled(isSaving || partnerName.trimmingCharacters(in: .whitespaces).isEmpty || locationId.isEmpty || lines.contains { $0.itemId.isEmpty })
                }
            }
        }
    }

    private func submit() async {
        guard let admin = session.currentEmployee, let token = session.token else { return }
        isSaving = true
        defer { isSaving = false }
        do {
            _ = try await client.createPurchaseOrder(
                date: dateFormatter.string(from: date), deliveryDate: dateFormatter.string(from: deliveryDate),
                partnerName: partnerName, locationId: locationId,
                items: lines.map { APIClient.NewTradeDocLine(itemId: $0.itemId, name: itemName[$0.itemId] ?? "", qty: $0.qty, unitPrice: $0.unitPrice) },
                memo: memo, user: admin.name, token: token
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
