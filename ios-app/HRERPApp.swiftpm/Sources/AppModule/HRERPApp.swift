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
        }
    }
}
