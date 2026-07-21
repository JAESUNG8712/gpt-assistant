import Foundation

/// 넓은 화면(사이드바 모드)에서는 "더보기" 허브로 묶을 필요 없이 모든 섹션을 사이드바에
/// 평평하게 나열한다 — 실제 웹 앱(public/index.html)의 좌측 사이드바와 동일한 구조.
enum AppSection: String, CaseIterable, Identifiable {
    case home, attendance, approvals, expense, notifications, directory
    case accounting, salesInventory, pms, recruit, kpi, settings
    case expenseAdmin, approvalAdmin, kpiApproval

    var id: String { rawValue }

    /// 관리자(`role=="admin"`)에게만 보이는 섹션 — 사이드바 목록을 만들 때 걸러낸다.
    var adminOnly: Bool {
        switch self {
        case .expenseAdmin, .approvalAdmin: return true
        default: return false
        }
    }

    /// KPI 평가자(팀장/사업부장/관리자)에게만 보이는 섹션 — `adminOnly`와 별개 기준이라
    /// (leader/director도 포함) 따로 둔다.
    var evaluatorOnly: Bool {
        switch self {
        case .kpiApproval: return true
        default: return false
        }
    }

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
        case .expenseAdmin: return "경비 정산 관리"
        case .approvalAdmin: return "전체 결재 관리"
        case .kpiApproval: return "KPI 평가 관리"
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
        case .expenseAdmin: return "wonsign.circle.fill"
        case .approvalAdmin: return "checkmark.seal.fill"
        case .kpiApproval: return "chart.bar.doc.horizontal.fill"
        }
    }
}
