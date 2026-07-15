import SwiftUI

@MainActor
struct LoginView: View {
    @EnvironmentObject private var settings: AppSettings
    @EnvironmentObject private var session: SessionStore

    @State private var loginId = ""
    @State private var password = ""
    @State private var otp = ""
    @State private var requireOtp = false

    var body: some View {
        NavigationStack {
            Form {
                Section("서버") {
                    TextField("https://hrsystem-uweb.onrender.com", text: $settings.serverURLString)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                }

                Section("로그인") {
                    TextField("아이디 (예: u2008001)", text: $loginId)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    SecureField("비밀번호", text: $password)
                    if requireOtp {
                        TextField("2단계 인증 코드", text: $otp)
                            .keyboardType(.numberPad)
                    }
                }

                if let error = session.loginError {
                    Section {
                        Text(error)
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }
                }

                Section {
                    Button {
                        Task { await login() }
                    } label: {
                        if session.isLoggingIn {
                            ProgressView()
                                .frame(maxWidth: .infinity)
                        } else {
                            Text("로그인")
                                .frame(maxWidth: .infinity)
                        }
                    }
                    .disabled(session.isLoggingIn || settings.baseURL == nil || loginId.isEmpty || password.isEmpty)
                }
            }
            .navigationTitle("인사 ERP")
        }
    }

    private func login() async {
        let client = APIClient(settings: settings)
        let success = await session.login(
            loginId: loginId,
            password: password,
            otp: requireOtp ? otp : nil,
            client: client
        )
        if !success && session.loginError?.contains("2단계") == true {
            requireOtp = true
        }
    }
}
