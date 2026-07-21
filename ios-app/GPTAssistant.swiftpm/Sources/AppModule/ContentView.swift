import SwiftUI

struct ContentView: View {
    var body: some View {
        TabView {
            ChatView()
                .tabItem { Label("채팅", systemImage: "bubble.left.and.bubble.right") }

            SettingsView()
                .tabItem { Label("설정", systemImage: "gearshape") }
        }
    }
}
