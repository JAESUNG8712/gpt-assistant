import SwiftUI

@MainActor
struct AccountingView: View {
    @EnvironmentObject private var settings: AppSettings
    @EnvironmentObject private var session: SessionStore

    private enum Tab: String, CaseIterable, Identifiable {
        case accounts = "계정과목"
        case vouchers = "전표"
        case costStatement = "원가명세서"
        case rcps = "RCPS"
        var id: String { rawValue }
    }

    @State private var tab: Tab = .accounts
    @State private var accounts: [Account] = []
    @State private var vouchers: [Voucher] = []
    @State private var rcpsIssuances: [RcpsIssuance] = []
    @State private var isLoading = false
    @State private var errorMessage: String?

    // 원가명세서는 목록이 아니라 기간 조회형이라, 초기 로딩(load())이 아니라 "조회" 버튼으로
    // 별도 로드한다 — 기본 기간은 이번 달 1일 ~ 오늘.
    @State private var costFrom: Date = Calendar.current.date(
        from: Calendar.current.dateComponents([.year, .month], from: Date())
    ) ?? Date()
    @State private var costTo: Date = Date()
    @State private var costStatement: CostStatement?
    @State private var isLoadingCost = false
    @State private var costErrorMessage: String?

    private var client: APIClient { APIClient(settings: settings) }
    // 근태 기록(DateHelpers)과 달리 이건 "특정 시점"이 아니라 사용자가 고른 달력 날짜라,
    // UTC로 강제 변환하면 시간대에 따라 하루가 밀릴 수 있다 — NewEmployeeView의 hireDate와
    // 동일하게 로컬(시스템) 타임존 기준으로 yyyy-MM-dd를 만든다.
    private var queryDateFormatter: DateFormatter {
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; return f
    }

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

            case .costStatement:
                AppCard(title: "조회 기간") {
                    DatePicker("시작일", selection: $costFrom, displayedComponents: .date)
                    DatePicker("종료일", selection: $costTo, displayedComponents: .date)
                    Button {
                        Task { await loadCostStatement() }
                    } label: {
                        Text(isLoadingCost ? "조회 중..." : "조회")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(AppPrimaryButtonStyle(isDisabled: isLoadingCost))
                    .disabled(isLoadingCost)
                    .padding(.top, 4)
                }

                if let costErrorMessage {
                    AppCard { Text(costErrorMessage).font(.footnote).foregroundStyle(AppTheme.danger) }
                }

                if let costStatement {
                    AppCard(title: "제조원가 (\(costStatement.from) ~ \(costStatement.to))") {
                        HStack(spacing: 10) {
                            StatTile(label: "재료비", value: wonText(costStatement.mfg.material))
                            StatTile(label: "노무비", value: wonText(costStatement.mfg.labor))
                        }
                        HStack(spacing: 10) {
                            StatTile(label: "경비", value: wonText(costStatement.mfg.overhead))
                            StatTile(label: "제조원가 합계", value: wonText(costStatement.mfg.total), tint: AppTheme.accentDark)
                        }
                    }
                    AppCard(title: "판매관리비") {
                        StatTile(label: "판관비 합계", value: wonText(costStatement.sga.total), tint: AppTheme.warning)
                    }
                    AppCard(title: "계정별 상세 (\(costStatement.byAccount.count))") {
                        if costStatement.byAccount.isEmpty {
                            EmptyState(message: "해당 기간의 원가 집계 내역이 없습니다.")
                        } else {
                            ForEach(costStatement.byAccount) { row in
                                HStack {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text("\(row.code)  \(row.name)").font(.subheadline.weight(.semibold))
                                        Text([row.costCategory, row.costSubType].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                                            .font(.caption)
                                            .foregroundStyle(AppTheme.secondaryText)
                                    }
                                    Spacer()
                                    Text(wonText(row.amount)).font(.subheadline.weight(.bold))
                                }
                                if row.id != costStatement.byAccount.last?.id {
                                    Divider()
                                }
                            }
                        }
                    }
                } else if !isLoadingCost {
                    EmptyState(message: "기간을 선택하고 조회하세요.")
                }

            case .rcps:
                if rcpsIssuances.isEmpty && !isLoading {
                    EmptyState(message: "등록된 RCPS 발행 내역이 없습니다.")
                }
                ForEach(rcpsIssuances) { issuance in
                    NavigationLink {
                        RcpsIssuanceDetailView(issuanceId: issuance.id)
                    } label: {
                        AppCard {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(issuance.name).font(.subheadline.weight(.semibold))
                                    Text("\(issuance.issueDate)\(issuance.maturityDate.map { " ~ \($0)" } ?? "")")
                                        .font(.caption)
                                        .foregroundStyle(AppTheme.secondaryText)
                                }
                                Spacer()
                                VStack(alignment: .trailing, spacing: 2) {
                                    Text(wonText(issuance.faceAmount)).font(.subheadline.weight(.bold))
                                    StatusPill(status: issuance.status)
                                }
                                Image(systemName: "chevron.right")
                                    .font(.caption)
                                    .foregroundStyle(AppTheme.secondaryText)
                            }
                        }
                    }
                    .buttonStyle(.plain)
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
            async let r = client.fetchRcpsIssuances(token: token)
            (accounts, vouchers, rcpsIssuances) = try await (a, v, r)
        } catch {
            if case APIError.serverError(401, _) = error {
                session.handleUnauthorized()
            } else {
                errorMessage = error.localizedDescription
            }
        }
    }

    private func loadCostStatement() async {
        guard let token = session.token else { return }
        isLoadingCost = true
        costErrorMessage = nil
        defer { isLoadingCost = false }
        do {
            costStatement = try await client.fetchCostStatement(
                from: queryDateFormatter.string(from: costFrom),
                to: queryDateFormatter.string(from: costTo),
                token: token
            )
        } catch {
            if case APIError.serverError(401, _) = error {
                session.handleUnauthorized()
            } else {
                costErrorMessage = error.localizedDescription
            }
        }
    }
}

/// 웹 앱 표시 규칙(`x.toLocaleString()+"원"`)과 동일한 원화 포맷 헬퍼 — 이 뷰 안 여러 곳(전표/
/// 제조원가/판관비/계정별 상세/RCPS 카드)에서 반복 사용해 한 곳으로 뺐다.
/// `Int(amount)`로 통째로 자르면 전표 금액(대개 정수 원 단위)은 문제없지만, RCPS 상각표는
/// 유효이자율법 계산상 원 단위 미만(예: 819,603,210.89원) 소수가 실제로 의미 있어 그대로
/// 잘리면 웹 화면(원 단위 그대로 toLocaleString)과 다른 값을 보여주게 된다 — 소수부가 있을
/// 때만 둘째 자리까지 보존한다.
private func wonText(_ amount: Double) -> String {
    let formatter = NumberFormatter()
    formatter.numberStyle = .decimal
    formatter.groupingSeparator = ","
    formatter.minimumFractionDigits = 0
    formatter.maximumFractionDigits = 2
    let text = formatter.string(from: NSNumber(value: amount)) ?? "\(amount)"
    return "\(text)원"
}

/// server.js는 couponRate/effectiveRate를 소수 표기로 저장한다(예: 연 5% → 0.05, RCPS 발행
/// POST 라우트 주석 참고). 웹 클라이언트(public/index.html)도 표시 시 항상 `(x*100).toFixed(2)+"%"`로
/// 변환하는데, 이 뷰는 그 변환 없이 원시 소수값 뒤에 그냥 "%"만 붙이고 있어 1%가 "0.01%"로
/// 표시되는 버그가 있었다 — 웹과 동일한 규칙(×100, 소수 둘째 자리)으로 통일한다.
private func percentText(_ rate: Double) -> String {
    String(format: "%.2f%%", rate * 100)
}

/// RCPS 발행 1건의 상세 — 발행 정보 요약 + 유효이자율법 상각표 + 공정가치평가 이력.
/// 조회 전용(README 명시): 상각전표 발행/공정가치평가 등록 등 쓰기 액션은 없음.
@MainActor
private struct RcpsIssuanceDetailView: View {
    @EnvironmentObject private var settings: AppSettings
    @EnvironmentObject private var session: SessionStore

    let issuanceId: String

    @State private var detail: RcpsIssuanceDetail?
    @State private var isLoading = false
    @State private var errorMessage: String?

    private var client: APIClient { APIClient(settings: settings) }

    var body: some View {
        Group {
            if let detail {
                AppScreen {
                    AppCard(title: "발행 정보") {
                        row("발행명", detail.issuance.name)
                        row("발행일", detail.issuance.issueDate)
                        row("만기일", detail.issuance.maturityDate)
                        row("액면금액", wonText(detail.issuance.faceAmount))
                        if let sharesIssued = detail.issuance.sharesIssued {
                            row("발행주식수", "\(Int(sharesIssued).formatted())주")
                        }
                        if let parValue = detail.issuance.parValue {
                            row("액면가", wonText(parValue))
                        }
                        if let couponRate = detail.issuance.couponRate {
                            row("표시이자율", percentText(couponRate))
                        }
                        if let effectiveRate = detail.issuance.effectiveRate {
                            row("유효이자율", percentText(effectiveRate))
                        }
                        if let redemptionAmount = detail.issuance.redemptionAmount {
                            row("상환금액", wonText(redemptionAmount))
                        }
                        if let liabilityInitial = detail.issuance.liabilityInitial {
                            row("부채요소 최초인식액", wonText(liabilityInitial))
                        }
                        if let equityResidual = detail.issuance.equityResidual {
                            row("자본요소 잔여", wonText(equityResidual))
                        }
                        HStack {
                            Text("상태").font(.caption).foregroundStyle(AppTheme.secondaryText)
                            Spacer()
                            StatusPill(status: detail.issuance.status)
                        }
                    }

                    AppCard(title: "상각표 (\(detail.schedule.count)회차)") {
                        if detail.schedule.isEmpty {
                            EmptyState(message: "등록된 상각표가 없습니다.")
                        } else {
                            ForEach(detail.schedule) { entry in
                                VStack(alignment: .leading, spacing: 4) {
                                    HStack {
                                        Text("\(entry.seq)회차 · \(entry.periodDate)").font(.subheadline.weight(.semibold))
                                        Spacer()
                                        StatusPill(status: entry.status)
                                    }
                                    HStack {
                                        Text("기초 \(wonText(entry.beginningBalance))")
                                        Spacer()
                                        Text("유효이자 \(wonText(entry.effectiveInterest))")
                                    }
                                    .font(.caption)
                                    .foregroundStyle(AppTheme.secondaryText)
                                    HStack {
                                        Text("표시이자 \(wonText(entry.statedInterest))")
                                        Spacer()
                                        Text("상각액 \(wonText(entry.amortization))")
                                    }
                                    .font(.caption)
                                    .foregroundStyle(AppTheme.secondaryText)
                                    Text("기말 \(wonText(entry.endingBalance))")
                                        .font(.caption.weight(.semibold))
                                        .foregroundStyle(AppTheme.primaryText)
                                }
                                if entry.id != detail.schedule.last?.id {
                                    Divider()
                                }
                            }
                        }
                    }

                    AppCard(title: "공정가치평가 이력 (\(detail.valuations.count))") {
                        if detail.valuations.isEmpty {
                            EmptyState(message: "등록된 공정가치평가 이력이 없습니다.")
                        } else {
                            ForEach(detail.valuations) { valuation in
                                VStack(alignment: .leading, spacing: 2) {
                                    HStack {
                                        Text(valuation.valuationDate).font(.subheadline.weight(.semibold))
                                        Spacer()
                                        Text(wonText(valuation.gainLoss))
                                            .font(.subheadline.weight(.bold))
                                            .foregroundStyle(valuation.gainLoss < 0 ? AppTheme.danger : AppTheme.success)
                                    }
                                    Text("직전장부 \(wonText(valuation.priorCarrying)) → 공정가치 \(wonText(valuation.fairValue))")
                                        .font(.caption)
                                        .foregroundStyle(AppTheme.secondaryText)
                                    if let memo = valuation.memo, !memo.isEmpty {
                                        Text(memo).font(.caption).foregroundStyle(AppTheme.secondaryText)
                                    }
                                }
                                if valuation.id != detail.valuations.last?.id {
                                    Divider()
                                }
                            }
                        }
                    }
                }
            } else if let errorMessage {
                AppScreen {
                    AppCard { Text(errorMessage).font(.footnote).foregroundStyle(AppTheme.danger) }
                }
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .navigationTitle(detail?.issuance.name ?? "RCPS 상세")
        .task { await load() }
    }

    private func load() async {
        guard let token = session.token else { return }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            detail = try await client.fetchRcpsIssuanceDetail(id: issuanceId, token: token)
        } catch {
            if case APIError.serverError(401, _) = error {
                session.handleUnauthorized()
            } else {
                errorMessage = error.localizedDescription
            }
        }
    }

    @ViewBuilder
    private func row(_ label: String, _ value: String?) -> some View {
        if let value, !value.isEmpty {
            HStack {
                Text(label).font(.caption).foregroundStyle(AppTheme.secondaryText)
                Spacer()
                Text(value).font(.subheadline)
            }
        }
    }
}
