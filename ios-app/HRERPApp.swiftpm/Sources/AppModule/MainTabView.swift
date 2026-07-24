import SwiftUI

/// iPhone·좁은 화면(compact)용 탭바 레이아웃. 넓은 화면(iPad 가로/큰 창)에서는
/// RootView가 대신 SidebarRootView(NavigationSplitView)를 보여준다.
///
/// 탭을 벗어났다가 돌아오면 그 탭이 "루트"부터 다시 보이도록 강제한다. 처음엔
/// `NavigationStack(path:)` + `NavigationPath()`로 리셋을 시도했지만, 이 앱의 모든 push가
/// `NavigationLink(value:)` + `.navigationDestination(for:)`가 아니라 옛 방식인
/// `NavigationLink { View } label: { ... }`(뷰 빌더 방식, Hashable 값이 없음)를 쓰고 있어
/// NavigationPath에 실제로 기록되지 않는다는 걸 QA에서 확인 — path를 비워도 내부 push
/// 스택은 그대로 남아 리셋이 안 되는 문제가 있었다. 그래서 각 탭의 NavigationStack 자체에
/// `.id()`를 걸어, 탭을 벗어나는 순간 id를 바꿔 스택 전체를 강제로 새로 만드는 방식으로
/// 바꿨다 — push 방식과 무관하게 항상 확실히 리셋된다.
@MainActor
struct MainTabView: View {
    @EnvironmentObject private var settings: AppSettings
    @EnvironmentObject private var session: SessionStore
    @StateObject private var store = HRDataStore()

    private enum Tab: Hashable { case home, attendance, approvals, expense, more, settings }

    @State private var selectedTab: Tab = .home
    @State private var homeResetID = UUID()
    @State private var attendanceResetID = UUID()
    @State private var approvalsResetID = UUID()
    @State private var expenseResetID = UUID()
    @State private var hubResetID = UUID()
    @State private var settingsResetID = UUID()

    private var client: APIClient { APIClient(settings: settings) }

    var body: some View {
        TabView(selection: $selectedTab) {
            NavigationStack {
                DashboardView(store: store, reload: reload)
            }
            .id(homeResetID)
            .tabItem { Label("홈", systemImage: "house") }
            .tag(Tab.home)

            NavigationStack {
                AttendanceView(store: store, reload: reload)
            }
            .id(attendanceResetID)
            .tabItem { Label("근태", systemImage: "clock") }
            .tag(Tab.attendance)

            NavigationStack {
                ApprovalsView(store: store, reload: reload)
            }
            .id(approvalsResetID)
            .tabItem { Label("전자결재", systemImage: "checkmark.seal") }
            .tag(Tab.approvals)

            NavigationStack {
                ExpenseView(store: store, reload: reload)
            }
            .id(expenseResetID)
            .tabItem { Label("경비청구", systemImage: "wonsign.circle") }
            .tag(Tab.expense)

            NavigationStack {
                ERPHubView(store: store, reload: reload)
            }
            .id(hubResetID)
            .tabItem { Label("더보기", systemImage: "square.grid.2x2") }
            .tag(Tab.more)

            NavigationStack {
                SettingsView()
            }
            .id(settingsResetID)
            .tabItem { Label("설정", systemImage: "gearshape") }
            .tag(Tab.settings)
        }
        .tint(AppTheme.accent)
        .onChange(of: selectedTab) { _, newValue in
            if newValue != .home { homeResetID = UUID() }
            if newValue != .attendance { attendanceResetID = UUID() }
            if newValue != .approvals { approvalsResetID = UUID() }
            if newValue != .expense { expenseResetID = UUID() }
            if newValue != .more { hubResetID = UUID() }
            if newValue != .settings { settingsResetID = UUID() }
        }
        .task {
            await reload()
        }
    }

    private func reload() async {
        await store.reload(client: client, session: session)
    }
}
