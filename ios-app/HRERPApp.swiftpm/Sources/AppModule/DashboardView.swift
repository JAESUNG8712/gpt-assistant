import SwiftUI

@MainActor
struct DashboardView: View {
    @EnvironmentObject private var settings: AppSettings
    @EnvironmentObject private var session: SessionStore
    @ObservedObject var store: HRDataStore
    let reload: () async -> Void

    @State private var isSavingAttendance = false

    private var client: APIClient { APIClient(settings: settings) }

    private var todayRecord: AttendanceRecord? {
        guard let empId = session.currentEmployee?.id else { return nil }
        let today = DateHelpers.todayDateString()
        return store.attendanceRecords.first { $0.empId == empId && $0.date == today }
    }

    private var pendingApprovalCount: Int {
        guard let empId = session.currentEmployee?.id else { return 0 }
        return store.approvalDocs.filter { doc in
            doc.status == "in_progress" && doc.approvers.contains { $0.empId == empId && $0.status == "pending" }
        }.count
    }

    private var myPendingExpenseCount: Int {
        guard let empId = session.currentEmployee?.id else { return 0 }
        return store.expenseClaims.filter { $0.empId == empId && $0.status == "pending" }.count
    }

    var body: some View {
        AppScreen {
            if let employee = session.currentEmployee {
                HStack(spacing: 14) {
                    ZStack {
                        Circle().fill(AppTheme.accentLight).frame(width: 52, height: 52)
                        Text(String(employee.name.prefix(1)))
                            .font(.title3.weight(.bold))
                            .foregroundStyle(AppTheme.accentDark)
                    }
                    VStack(alignment: .leading, spacing: 2) {
                        Text(employee.name).font(.title3.weight(.bold)).foregroundStyle(AppTheme.primaryText)
                        Text([employee.dept, employee.team, employee.position].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                            .font(.caption)
                            .foregroundStyle(AppTheme.secondaryText)
                    }
                    Spacer()
                }
            }

            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 12) {
                StatTile(label: "내가 처리할 결재", value: "\(pendingApprovalCount)건", tint: AppTheme.warning)
                StatTile(label: "대기중 경비청구", value: "\(myPendingExpenseCount)건", tint: AppTheme.warning)
                StatTile(label: "전체 직원", value: "\(store.employees.count)명", tint: AppTheme.accent)
                StatTile(label: "등록된 KPI", value: "\(store.kpiEntries.count)건", tint: AppTheme.accent)
            }

            AppCard(title: "오늘 근태 (\(DateHelpers.todayDateString()))") {
                let record = todayRecord
                let checkedIn = !(record?.checkIn ?? "").isEmpty
                let checkedOut = !(record?.checkOut ?? "").isEmpty

                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("출근").font(.caption).foregroundStyle(AppTheme.secondaryText)
                        Text(checkedIn ? record!.checkIn! : "-").font(.title3.weight(.semibold))
                    }
                    Spacer()
                    VStack(alignment: .leading, spacing: 2) {
                        Text("퇴근").font(.caption).foregroundStyle(AppTheme.secondaryText)
                        Text(checkedOut ? record!.checkOut! : "-").font(.title3.weight(.semibold))
                    }
                    Spacer()
                }

                HStack(spacing: 10) {
                    Button("출근 체크") { Task { await checkIn() } }
                        .buttonStyle(AppPrimaryButtonStyle(isDisabled: isSavingAttendance || checkedIn))
                        .disabled(isSavingAttendance || checkedIn)
                    Button("퇴근 체크") { Task { await checkOut() } }
                        .buttonStyle(.bordered)
                        .tint(AppTheme.accent)
                        .disabled(isSavingAttendance || checkedOut)
                }
            }

            AppCard(title: "바로가기") {
                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
                    NavigationLink { EmployeeDirectoryView(store: store, reload: reload) } label: { QuickLinkTile(icon: "person.2", title: "조직도") }
                    NavigationLink { AccountingView() } label: { QuickLinkTile(icon: "wonsign.square", title: "회계") }
                    NavigationLink { SalesInventoryView() } label: { QuickLinkTile(icon: "shippingbox", title: "영업/재고") }
                    NavigationLink { PMSView() } label: { QuickLinkTile(icon: "chart.bar.doc.horizontal", title: "PMS") }
                    NavigationLink { RecruitView() } label: { QuickLinkTile(icon: "person.badge.plus", title: "채용") }
                    NavigationLink { KPIView(store: store, reload: reload) } label: { QuickLinkTile(icon: "chart.line.uptrend.xyaxis", title: "평가/KPI") }
                }
            }

            if let lastLoaded = store.lastLoadedAt {
                Text("마지막 동기화: \(lastLoaded.formatted(date: .omitted, time: .shortened))")
                    .font(.caption)
                    .foregroundStyle(AppTheme.secondaryText)
            }

            if let error = store.lastError {
                AppCard { Text(error).font(.footnote).foregroundStyle(AppTheme.danger) }
            }
        }
        .navigationTitle("홈")
        .refreshable { await reload() }
        .overlay {
            if store.isLoading && store.lastLoadedAt == nil {
                ProgressView()
            }
        }
    }

    private func checkIn() async {
        guard let empId = session.currentEmployee?.id else { return }
        isSavingAttendance = true
        defer { isSavingAttendance = false }
        store.checkIn(empId: empId, date: DateHelpers.todayDateString(), time: DateHelpers.nowTimeString())
        await store.save(client: client, session: session)
    }

    private func checkOut() async {
        guard let empId = session.currentEmployee?.id else { return }
        isSavingAttendance = true
        defer { isSavingAttendance = false }
        store.checkOut(empId: empId, date: DateHelpers.todayDateString(), time: DateHelpers.nowTimeString())
        await store.save(client: client, session: session)
    }
}
