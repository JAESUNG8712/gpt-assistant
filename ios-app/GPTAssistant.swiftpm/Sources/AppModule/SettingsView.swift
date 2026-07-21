import SwiftUI

@MainActor
struct SettingsView: View {
    @EnvironmentObject private var settings: AppSettings
    @State private var statusMessage: String = ""
    @State private var isChecking = false

    var body: some View {
        NavigationStack {
            Form {
                Section("백엔드 서버 (ai/main.py)") {
                    TextField("https://your-app.onrender.com", text: $settings.serverURLString)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)

                    Button {
                        Task { await checkHealth() }
                    } label: {
                        if isChecking {
                            ProgressView()
                        } else {
                            Text("연결 확인")
                        }
                    }
                    .disabled(settings.serverURLString.isEmpty || isChecking)

                    if !statusMessage.isEmpty {
                        Text(statusMessage)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }

                Section("안내") {
                    Text("""
                    이 앱은 ai/main.py FastAPI 백엔드(Render/Railway 등에 배포)에 연결합니다. \
                    저장소에 docs/API_CONTRACT.md가 없어, ai/main.py·ai/personas.py·ai/memory.py의 \
                    실제 엔드포인트를 기준으로 만들었습니다. 서버 주소는 반드시 https:// 로 시작해야 합니다 \
                    (App Transport Security로 인해 http는 차단됩니다).
                    """)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("설정")
        }
    }

    private func checkHealth() async {
        isChecking = true
        defer { isChecking = false }
        do {
            let client = APIClient(settings: settings)
            let health = try await client.checkHealth()
            let backend = health.db_backend ?? (health.db_exists.map { $0 ? "SQLite (있음)" : "SQLite (없음)" } ?? "알 수 없음")
            statusMessage = "✅ 연결 성공 (status: \(health.status), DB: \(backend))"
        } catch {
            statusMessage = "❌ \(error.localizedDescription)"
        }
    }
}
