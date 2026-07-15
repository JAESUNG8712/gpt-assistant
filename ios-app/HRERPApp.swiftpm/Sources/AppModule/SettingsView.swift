import SwiftUI

@MainActor
struct SettingsView: View {
    @EnvironmentObject private var settings: AppSettings
    @EnvironmentObject private var session: SessionStore
    @State private var statusMessage = ""
    @State private var isChecking = false

    var body: some View {
        NavigationStack {
            Form {
                if let employee = session.currentEmployee {
                    Section("로그인 계정") {
                        LabeledContent("이름", value: employee.name)
                        if let loginId = employee.loginId {
                            LabeledContent("아이디", value: loginId)
                        }
                        if let role = employee.role {
                            LabeledContent("역할", value: role)
                        }
                    }
                }

                Section("서버") {
                    TextField("https://hrsystem-uweb.onrender.com", text: $settings.serverURLString)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)

                    Button {
                        Task { await checkStatus() }
                    } label: {
                        if isChecking {
                            ProgressView()
                        } else {
                            Text("연결 확인")
                        }
                    }
                    .disabled(settings.serverURLString.isEmpty || isChecking)

                    if !statusMessage.isEmpty {
                        Text(statusMessage).font(.footnote).foregroundStyle(.secondary)
                    }
                }

                Section {
                    Button("로그아웃", role: .destructive) {
                        session.logout()
                    }
                }
            }
            .navigationTitle("설정")
        }
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
