import SwiftUI

@MainActor
struct MainTabView: View {
    @EnvironmentObject private var settings: AppSettings
    @EnvironmentObject private var session: SessionStore
    @StateObject private var store = HRDataStore()

    private var client: APIClient { APIClient(settings: settings) }

    var body: some View {
        TabView {
            DashboardView(store: store, reload: reload)
                .tabItem { Label("홈", systemImage: "house") }

            AttendanceView(store: store, reload: reload)
                .tabItem { Label("근태", systemImage: "clock") }

            ApprovalsView(store: store, reload: reload)
                .tabItem { Label("전자결재", systemImage: "checkmark.seal") }

            ExpenseView(store: store, reload: reload)
                .tabItem { Label("경비청구", systemImage: "wonsign.circle") }

            ERPHubView(store: store, reload: reload)
                .tabItem { Label("더보기", systemImage: "square.grid.2x2") }

            SettingsView()
                .tabItem { Label("설정", systemImage: "gearshape") }
        }
        .tint(AppTheme.accent)
        .task {
            await reload()
        }
    }

    private func reload() async {
        await store.reload(client: client, session: session)
    }
}
