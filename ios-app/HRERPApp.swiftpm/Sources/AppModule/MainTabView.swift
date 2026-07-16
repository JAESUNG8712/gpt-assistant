import SwiftUI

/// iPhone·좁은 화면(compact)용 탭바 레이아웃. 넓은 화면(iPad 가로/큰 창)에서는
/// RootView가 대신 SidebarRootView(NavigationSplitView)를 보여준다.
///
/// 탭마다 별도 NavigationPath를 갖고, 다른 탭으로 전환하는 순간 그 탭의 path를 리셋한다 —
/// 그렇게 하지 않으면(예: 더보기 → 조직도 → 직원 상세까지 들어간 뒤 다른 탭 갔다가 다시
/// 더보기로 돌아오면) 이전에 들어갔던 세부 화면이 그대로 남아있어서, 정작 원했던 "더보기"
/// 목록을 보려면 뒤로가기를 한 번 더 눌러야 하는 문제가 있었다.
@MainActor
struct MainTabView: View {
    @EnvironmentObject private var settings: AppSettings
    @EnvironmentObject private var session: SessionStore
    @StateObject private var store = HRDataStore()

    private enum Tab: Hashable { case home, attendance, approvals, expense, more, settings }

    @State private var selectedTab: Tab = .home
    @State private var homePath = NavigationPath()
    @State private var attendancePath = NavigationPath()
    @State private var approvalsPath = NavigationPath()
    @State private var expensePath = NavigationPath()
    @State private var hubPath = NavigationPath()
    @State private var settingsPath = NavigationPath()

    private var client: APIClient { APIClient(settings: settings) }

    var body: some View {
        TabView(selection: $selectedTab) {
            NavigationStack(path: $homePath) {
                DashboardView(store: store, reload: reload)
            }
            .tabItem { Label("홈", systemImage: "house") }
            .tag(Tab.home)

            NavigationStack(path: $attendancePath) {
                AttendanceView(store: store, reload: reload)
            }
            .tabItem { Label("근태", systemImage: "clock") }
            .tag(Tab.attendance)

            NavigationStack(path: $approvalsPath) {
                ApprovalsView(store: store, reload: reload)
            }
            .tabItem { Label("전자결재", systemImage: "checkmark.seal") }
            .tag(Tab.approvals)

            NavigationStack(path: $expensePath) {
                ExpenseView(store: store, reload: reload)
            }
            .tabItem { Label("경비청구", systemImage: "wonsign.circle") }
            .tag(Tab.expense)

            NavigationStack(path: $hubPath) {
                ERPHubView(store: store, reload: reload)
            }
            .tabItem { Label("더보기", systemImage: "square.grid.2x2") }
            .tag(Tab.more)

            NavigationStack(path: $settingsPath) {
                SettingsView()
            }
            .tabItem { Label("설정", systemImage: "gearshape") }
            .tag(Tab.settings)
        }
        .tint(AppTheme.accent)
        .onChange(of: selectedTab) { newValue in
            if newValue != .home { homePath = NavigationPath() }
            if newValue != .attendance { attendancePath = NavigationPath() }
            if newValue != .approvals { approvalsPath = NavigationPath() }
            if newValue != .expense { expensePath = NavigationPath() }
            if newValue != .more { hubPath = NavigationPath() }
            if newValue != .settings { settingsPath = NavigationPath() }
        }
        .task {
            await reload()
        }
    }

    private func reload() async {
        await store.reload(client: client, session: session)
    }
}
