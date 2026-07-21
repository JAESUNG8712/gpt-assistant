import SwiftUI

@main
struct HRERPApp: App {
    @StateObject private var settings = AppSettings()
    @StateObject private var session = SessionStore()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(settings)
                .environmentObject(session)
                .tint(AppTheme.accent)
                // 실제 웹 앱(public/index.html)이 라이트 테마 전용이라, 시스템 다크모드와
                // 무관하게 항상 밝은 카드형 디자인으로 통일한다.
                .preferredColorScheme(.light)
        }
    }
}
