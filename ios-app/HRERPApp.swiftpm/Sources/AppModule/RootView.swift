import SwiftUI

@MainActor
struct RootView: View {
    @EnvironmentObject private var session: SessionStore
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    var body: some View {
        if session.isAuthenticated {
            // 창을 크게 늘리거나 iPad를 가로로 놓으면(regular) 웹 앱과 동일하게 좌측 사이드바
            // 레이아웃을 쓰고, 좁은 화면(compact)에서는 하단 탭바 레이아웃을 쓴다.
            if horizontalSizeClass == .regular {
                SidebarRootView()
            } else {
                MainTabView()
            }
        } else {
            LoginView()
        }
    }
}
