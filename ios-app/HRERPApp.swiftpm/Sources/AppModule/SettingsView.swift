import SwiftUI

@MainActor
struct SettingsView: View {
    @EnvironmentObject private var settings: AppSettings
    @EnvironmentObject private var session: SessionStore
    @State private var statusMessage = ""
    @State private var isChecking = false

    var body: some View {
        AppScreen {
            if let employee = session.currentEmployee {
                AppCard(title: "로그인 계정") {
                    LabeledContent("이름", value: employee.name)
                    if let loginId = employee.loginId {
                        LabeledContent("아이디", value: loginId)
                    }
                    if let role = employee.role {
                        LabeledContent("역할", value: role)
                    }
                }
            }

            AppCard(title: "서버") {
                TextField("https://your-server.example.com", text: $settings.serverURLString)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                    .appFieldStyle()

                Button {
                    Task { await checkStatus() }
                } label: {
                    if isChecking {
                        ProgressView().tint(.white)
                    } else {
                        Text("연결 확인")
                    }
                }
                .buttonStyle(AppPrimaryButtonStyle(isDisabled: settings.serverURLString.isEmpty || isChecking))
                .disabled(settings.serverURLString.isEmpty || isChecking)

                if !statusMessage.isEmpty {
                    Text(statusMessage).font(.footnote).foregroundStyle(AppTheme.secondaryText)
                }
            }

            Button("로그아웃") {
                session.logout()
            }
            .buttonStyle(.bordered)
            .tint(AppTheme.danger)
            .frame(maxWidth: .infinity)
        }
        .navigationTitle("설정")
    }

    private func checkStatus() async {
        isChecking = true
        defer { isChecking = false }
        do {
            let client = APIClient(settings: settings)
            let result = try await client.checkStatus()
            let empCount = (result["meta"] as? [String: Any])?["empCount"] as? Int
            statusMessage = "✅ 연결 성공" + (empCount.map { " (직원 \($0)명)" } ?? "")
        } catch {
            statusMessage = "❌ \(error.localizedDescription)"
        }
    }
}
