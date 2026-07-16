import SwiftUI

/// 넓은 화면(iPad 가로모드로 창을 키우거나 Split View를 넓게 잡았을 때)에서 쓰는 레이아웃 —
/// 실제 웹 앱과 동일하게 좌측에 전체 메뉴가 항상 보이는 사이드바 + 우측 상세 2단 구성.
/// 좁은 화면에서는 RootView가 대신 MainTabView(하단 탭바)를 보여준다.
@MainActor
struct SidebarRootView: View {
    @EnvironmentObject private var settings: AppSettings
    @EnvironmentObject private var session: SessionStore
    @StateObject private var store = HRDataStore()

    @State private var selection: AppSection? = .home
    @State private var detailPath = NavigationPath()

    private var client: APIClient { APIClient(settings: settings) }

    var body: some View {
        NavigationSplitView {
            List(selection: $selection) {
                ForEach(AppSection.allCases) { section in
                    Label(section.title, systemImage: section.icon).tag(section)
                }
            }
            .navigationTitle("인사 ERP")
            .listStyle(.sidebar)
        } detail: {
            NavigationStack(path: $detailPath) {
                destination
            }
        }
        .tint(AppTheme.accent)
        .onChange(of: selection) { _ in
            // 사이드바에서 다른 섹션을 고르면 이전 섹션에서 눌러 들어갔던 세부 화면이
            // 그대로 남아있지 않도록 상세 영역의 push 스택을 리셋한다.
            detailPath = NavigationPath()
        }
        .task {
            await reload()
        }
    }

    @ViewBuilder
    private var destination: some View {
        switch selection ?? .home {
        case .home: DashboardView(store: store, reload: reload)
        case .attendance: AttendanceView(store: store, reload: reload)
        case .approvals: ApprovalsView(store: store, reload: reload)
        case .expense: ExpenseView(store: store, reload: reload)
        case .notifications: NotificationsView(store: store, reload: reload)
        case .directory: EmployeeDirectoryView(store: store, reload: reload)
        case .accounting: AccountingView()
        case .salesInventory: SalesInventoryView()
        case .pms: PMSView()
        case .recruit: RecruitView()
        case .kpi: KPIView(store: store, reload: reload)
        case .settings: SettingsView()
        }
    }

    private func reload() async {
        await store.reload(client: client, session: session)
    }
}
