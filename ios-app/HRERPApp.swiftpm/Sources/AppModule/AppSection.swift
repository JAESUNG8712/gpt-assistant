import Foundation

/// 넓은 화면(사이드바 모드)에서는 "더보기" 허브로 묶을 필요 없이 모든 섹션을 사이드바에
/// 평평하게 나열한다 — 실제 웹 앱(public/index.html)의 좌측 사이드바와 동일한 구조.
enum AppSection: String, CaseIterable, Identifiable {
    case home, attendance, approvals, expense, notifications, directory
    case accounting, salesInventory, pms, recruit, kpi, settings

    var id: String { rawValue }

    var title: String {
        switch self {
        case .home: return "홈"
        case .attendance: return "근태"
        case .approvals: return "전자결재"
        case .expense: return "경비청구"
        case .notifications: return "알림"
        case .directory: return "조직도"
        case .accounting: return "회계"
        case .salesInventory: return "영업/재고"
        case .pms: return "PMS"
        case .recruit: return "채용"
        case .kpi: return "평가/KPI"
        case .settings: return "설정"
        }
    }

    var icon: String {
        switch self {
        case .home: return "house"
        case .attendance: return "clock"
        case .approvals: return "checkmark.seal"
        case .expense: return "wonsign.circle"
        case .notifications: return "bell"
        case .directory: return "person.2"
        case .accounting: return "wonsign.square"
        case .salesInventory: return "shippingbox"
        case .pms: return "chart.bar.doc.horizontal"
        case .recruit: return "person.badge.plus"
        case .kpi: return "chart.line.uptrend.xyaxis"
        case .settings: return "gearshape"
        }
    }
}
