import SwiftUI

@MainActor
struct LoginView: View {
    @EnvironmentObject private var settings: AppSettings
    @EnvironmentObject private var session: SessionStore

    @State private var loginId = ""
    @State private var password = ""
    @State private var otp = ""
    @State private var requireOtp = false
    @State private var isPasswordVisible = false
    @State private var showServerField = false

    private var isFormValid: Bool {
        settings.baseURL != nil && !settings.companyCode.trimmingCharacters(in: .whitespaces).isEmpty
            && !loginId.isEmpty && !password.isEmpty
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 20) {
                VStack(spacing: 6) {
                    ZStack {
                        Circle().fill(AppTheme.accentLight).frame(width: 64, height: 64)
                        Image(systemName: "building.2.fill").font(.title2).foregroundStyle(AppTheme.accentDark)
                    }
                    Text("인사 ERP")
                        .font(.title.weight(.bold))
                        .foregroundStyle(AppTheme.primaryText)
                }
                .padding(.top, 40)

                AppCard {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("회사 코드").font(.caption.weight(.semibold)).foregroundStyle(AppTheme.secondaryText)
                        TextField("관리자에게 전달받은 회사 코드", text: $settings.companyCode)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .appFieldStyle()
                    }

                    VStack(alignment: .leading, spacing: 6) {
                        Text("아이디").font(.caption.weight(.semibold)).foregroundStyle(AppTheme.secondaryText)
                        TextField("예: u2008001", text: $loginId)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .appFieldStyle()
                    }

                    VStack(alignment: .leading, spacing: 6) {
                        Text("비밀번호").font(.caption.weight(.semibold)).foregroundStyle(AppTheme.secondaryText)
                        HStack(spacing: 8) {
                            Group {
                                if isPasswordVisible {
                                    TextField("비밀번호", text: $password)
                                } else {
                                    SecureField("비밀번호", text: $password)
                                }
                            }
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()

                            Button {
                                isPasswordVisible.toggle()
                            } label: {
                                Image(systemName: isPasswordVisible ? "eye.slash" : "eye")
                                    .foregroundStyle(AppTheme.secondaryText)
                            }
                            .buttonStyle(.plain)
                        }
                        .appFieldStyle()
                    }

                    if requireOtp {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("2단계 인증 코드").font(.caption.weight(.semibold)).foregroundStyle(AppTheme.secondaryText)
                            TextField("6자리 코드", text: $otp)
                                .keyboardType(.numberPad)
                                .appFieldStyle()
                        }
                    }

                    if let error = session.loginError {
                        Text(error)
                            .font(.footnote)
                            .foregroundStyle(AppTheme.danger)
                    }

                    Button {
                        Task { await login() }
                    } label: {
                        if session.isLoggingIn {
                            ProgressView().tint(.white)
                        } else {
                            Text("로그인")
                        }
                    }
                    .buttonStyle(AppPrimaryButtonStyle(isDisabled: !isFormValid))
                    .disabled(session.isLoggingIn || !isFormValid)
                    .padding(.top, 4)
                }

                DisclosureGroup("서버 설정", isExpanded: $showServerField) {
                    TextField("https://hrsystem-uweb.onrender.com", text: $settings.serverURLString)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                        .appFieldStyle()
                        .padding(.top, 8)
                }
                .font(.caption.weight(.semibold))
                .foregroundStyle(AppTheme.secondaryText)
                .padding(16)
                .background(AppTheme.card)
                .clipShape(RoundedRectangle(cornerRadius: 14))
                .overlay(RoundedRectangle(cornerRadius: 14).stroke(AppTheme.border, lineWidth: 1))
            }
            .padding(20)
            .frame(maxWidth: 420)
            .frame(maxWidth: .infinity)
        }
        .background(AppTheme.background)
    }

    private func login() async {
        let client = APIClient(settings: settings)
        let success = await session.login(
            loginId: loginId,
            password: password,
            otp: requireOtp ? otp : nil,
            companyCode: settings.companyCode,
            client: client
        )
        if !success && session.loginError?.contains("2단계") == true {
            requireOtp = true
        }
    }
}
