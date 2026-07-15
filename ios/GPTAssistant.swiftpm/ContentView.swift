import SwiftUI

struct ContentView: View {
    // 배포 URL — Render + Turso 백엔드. 필요 시 이 값만 바꾸면 다른 배포로 전환 가능.
    private let appURL = URL(string: "https://ai-assist-aosk.onrender.com")!

    @State private var isLoading = true
    @State private var loadError: String?
    @State private var reloadTrigger = 0

    var body: some View {
        ZStack {
            WebView(url: appURL, isLoading: $isLoading, loadError: $loadError, reloadTrigger: $reloadTrigger)
                .ignoresSafeArea(edges: .bottom)

            if isLoading && loadError == nil {
                ProgressView("불러오는 중…")
                    .progressViewStyle(.circular)
                    .padding(24)
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16))
            }

            if let loadError {
                VStack(spacing: 16) {
                    Image(systemName: "wifi.exclamationmark")
                        .font(.system(size: 40))
                        .foregroundStyle(.secondary)
                    Text(loadError)
                        .multilineTextAlignment(.center)
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 32)
                    Button {
                        reloadTrigger += 1
                    } label: {
                        Label("다시 시도", systemImage: "arrow.clockwise")
                            .padding(.horizontal, 8)
                    }
                    .buttonStyle(.borderedProminent)
                }
                .padding(24)
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 20))
                .padding(32)
            }
        }
    }
}
