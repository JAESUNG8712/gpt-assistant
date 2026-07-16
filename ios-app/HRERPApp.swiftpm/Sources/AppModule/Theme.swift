import SwiftUI

/// public/index.html(실제 웹 앱)이 쓰는 색상을 그대로 옮긴 디자인 시스템.
/// 배경 #f1f5f9, 카드 흰색 + 옅은 테두리, 포인트 컬러 #2563eb — 짙은 회색 기본 Form/List
/// 스타일 대신, 실제 서비스와 같은 밝고 깔끔한 카드형 레이아웃을 쓰기 위해 도입했다.
enum AppTheme {
    static let background = Color(hex: 0xF1F5F9)
    static let card = Color.white
    static let border = Color(hex: 0xE2E8F0)
    static let primaryText = Color(hex: 0x1E293B)
    static let secondaryText = Color(hex: 0x64748B)
    static let accent = Color(hex: 0x2563EB)
    static let accentDark = Color(hex: 0x1E40AF)
    static let accentLight = Color(hex: 0xEAF1FF)
    static let success = Color(hex: 0x16A34A)
    static let danger = Color(hex: 0xDC2626)
    static let warning = Color(hex: 0xF59E0B)
}

extension Color {
    init(hex: UInt32) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xff) / 255,
            green: Double((hex >> 8) & 0xff) / 255,
            blue: Double(hex & 0xff) / 255,
            opacity: 1
        )
    }
}

/// 웹 앱의 `.card` 스타일(흰 배경, 12~14px 라운드, 옅은 그림자)을 그대로 흉내낸 컨테이너.
struct AppCard<Content: View>: View {
    var title: String?
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let title {
                Text(title)
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(AppTheme.primaryText)
            }
            content
        }
        .padding(16)
        .background(AppTheme.card)
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(AppTheme.border, lineWidth: 1))
        .shadow(color: Color(hex: 0x1E3A5F).opacity(0.04), radius: 10, y: 2)
    }
}

/// 웹 앱의 `.stat-box`와 동일한 숫자 요약 타일.
struct StatTile: View {
    let label: String
    let value: String
    var tint: Color = AppTheme.accent

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label)
                .font(.caption)
                .foregroundStyle(AppTheme.secondaryText)
            Text(value)
                .font(.title3.weight(.bold))
                .foregroundStyle(AppTheme.primaryText)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(AppTheme.card)
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(AppTheme.border, lineWidth: 1))
        .overlay(alignment: .topTrailing) {
            Circle().fill(tint).frame(width: 6, height: 6).padding(10)
        }
    }
}

/// 웹 앱의 `.cl-card`(모듈 진입 카드)와 동일한 그리드 타일 — 홈 화면 모듈 허브에 사용.
struct ModuleCard: View {
    let icon: String
    let title: String
    let subtitle: String

    var body: some View {
        HStack(spacing: 12) {
            ZStack {
                RoundedRectangle(cornerRadius: 11)
                    .fill(LinearGradient(colors: [AppTheme.accentLight, Color(hex: 0xDBE6FB)], startPoint: .topLeading, endPoint: .bottomTrailing))
                    .overlay(RoundedRectangle(cornerRadius: 11).stroke(Color(hex: 0xDBE6FB), lineWidth: 1))
                    .frame(width: 40, height: 40)
                Image(systemName: icon)
                    .foregroundStyle(AppTheme.accentDark)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(AppTheme.primaryText)
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(AppTheme.secondaryText)
                    .lineLimit(1)
            }
            Spacer()
            Image(systemName: "chevron.right")
                .font(.caption)
                .foregroundStyle(AppTheme.secondaryText)
        }
        .padding(14)
        .background(AppTheme.card)
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(AppTheme.border, lineWidth: 1))
    }
}

/// 빈 목록 표시 — 기존 다크 스타일 대신 밝은 테마에 맞춘 버전.
struct EmptyState: View {
    let message: String

    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: "tray")
                .font(.largeTitle)
                .foregroundStyle(AppTheme.secondaryText.opacity(0.6))
            Text(message)
                .foregroundStyle(AppTheme.secondaryText)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 40)
    }
}

/// server.js의 상태값(status)을 한글 뱃지로 통일 표시 — 전자결재/경비청구/견적서/발주서 등에서 공용.
struct StatusPill: View {
    let status: String

    private static let labels: [String: String] = [
        "in_progress": "진행중", "approved": "승인완료", "rejected": "반려", "cancelled": "취소",
        "pending": "대기", "waiting": "대기", "draft": "임시저장", "sent": "발송됨",
        "accepted": "수락됨", "shipped": "출고완료", "ordered": "발주완료", "received": "입고완료",
        "open": "모집중", "closed": "마감", "active": "진행중", "posted": "확정",
        "void": "취소",
    ]

    private static let colors: [String: Color] = [
        "approved": AppTheme.success, "accepted": AppTheme.success, "shipped": AppTheme.success,
        "received": AppTheme.success, "posted": AppTheme.success, "active": AppTheme.success, "open": AppTheme.success,
        "rejected": AppTheme.danger, "cancelled": AppTheme.secondaryText, "closed": AppTheme.secondaryText,
        "void": AppTheme.secondaryText,
    ]

    var body: some View {
        Text(Self.labels[status] ?? status)
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background((Self.colors[status] ?? AppTheme.warning).opacity(0.12))
            .foregroundStyle(Self.colors[status] ?? AppTheme.warning)
            .clipShape(Capsule())
    }
}

/// 웹 앱의 `.fc` 입력 필드 스타일(흰 배경, 옅은 테두리, 8px 라운드)을 텍스트 필드에 적용.
struct AppFieldStyle: ViewModifier {
    func body(content: Content) -> some View {
        content
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(AppTheme.card)
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(AppTheme.border, lineWidth: 1))
    }
}

extension View {
    func appFieldStyle() -> some View { modifier(AppFieldStyle()) }
}

/// 웹 앱의 `.btn-primary`(파란 배경 버튼)와 동일한 형태.
struct AppPrimaryButtonStyle: ButtonStyle {
    var isDisabled: Bool = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 12)
            .background(isDisabled ? AppTheme.secondaryText.opacity(0.4) : AppTheme.accent)
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .opacity(configuration.isPressed ? 0.85 : 1)
    }
}

/// List/Form 대신 쓰는 공통 스크롤 컨테이너 — 배경을 AppTheme.background로 통일한다.
/// LazyVStack을 써서 직원 257명·전표·견적서처럼 긴 목록도 스크롤 성능이 떨어지지 않게 한다.
struct AppScreen<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 14) {
                content
            }
            .padding(16)
        }
        .background(AppTheme.background)
        .scrollContentBackground(.hidden)
    }
}
