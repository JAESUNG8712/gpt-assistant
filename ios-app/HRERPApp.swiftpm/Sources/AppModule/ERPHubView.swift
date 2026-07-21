import SwiftUI

/// 근태·전자결재·경비청구·홈처럼 자주 쓰는 화면은 하단 탭에 바로 두고, 그 외 모듈
/// (알림·조직도·회계·영업재고·PMS·채용·평가)은 이 허브에서 카드로 진입한다 — 탭이 6개를
/// 넘어가면 iPad에서도 UX가 나빠지므로, "실사용 앱"처럼 자주 쓰는 것과 가끔 쓰는 것을
/// 구분했다. NavigationStack은 이 뷰가 아니라 상위(MainTabView/SidebarRootView)가 갖고
/// 있다 — 탭을 벗어났다가 돌아왔을 때 이전 진입 화면 깊이가 남아있던 문제(뒤로가기를
/// 두 번 눌러야 이 목록이 보이던 버그)를 상위에서 path를 리셋하는 방식으로 고쳤다.
@MainActor
struct ERPHubView: View {
    @EnvironmentObject private var session: SessionStore
    @ObservedObject var store: HRDataStore
    let reload: () async -> Void

    private var isAdmin: Bool { session.currentEmployee?.role == "admin" }
    private var isEvaluator: Bool {
        guard let role = session.currentEmployee?.role else { return false }
        return ["leader", "director", "admin"].contains(role)
    }

    var body: some View {
        AppScreen {
            NavigationLink { NotificationsView(store: store, reload: reload) } label: {
                ModuleCard(icon: "bell", title: "알림", subtitle: "결재 대기 · 경비청구 · 재고 부족")
            }
            if isAdmin {
                NavigationLink { ExpenseAdminView(store: store, reload: reload) } label: {
                    ModuleCard(icon: "wonsign.circle.fill", title: "경비 정산 관리", subtitle: "전체 청구 승인 · 반려 · 지급 처리")
                }
                NavigationLink { ApprovalAdminView(store: store, reload: reload) } label: {
                    ModuleCard(icon: "checkmark.seal.fill", title: "전체 결재 관리", subtitle: "전 직원 결재 문서 조회 · 강제 반려")
                }
            }
            if isEvaluator {
                NavigationLink { KPIApprovalView(store: store, reload: reload) } label: {
                    ModuleCard(icon: "chart.bar.doc.horizontal.fill", title: "KPI 평가 관리", subtitle: "팀원 1차/2차 평가 · 최종 확정")
                }
            }
            NavigationLink { EmployeeDirectoryView(store: store, reload: reload) } label: {
                ModuleCard(icon: "person.2", title: "조직도", subtitle: "\(store.employees.count)명 직원 검색")
            }
            NavigationLink { AccountingView() } label: {
                ModuleCard(icon: "wonsign.square", title: "회계", subtitle: "계정과목 · 전표")
            }
            NavigationLink { SalesInventoryView() } label: {
                ModuleCard(icon: "shippingbox", title: "영업/재고", subtitle: "품목 · 견적서 · 발주서 · 재고현황")
            }
            NavigationLink { PMSView() } label: {
                ModuleCard(icon: "chart.bar.doc.horizontal", title: "PMS", subtitle: "프로젝트 · 투입률")
            }
            NavigationLink { RecruitView() } label: {
                ModuleCard(icon: "person.badge.plus", title: "채용", subtitle: "공고 · 지원자")
            }
            NavigationLink { KPIView(store: store, reload: reload) } label: {
                ModuleCard(icon: "chart.line.uptrend.xyaxis", title: "평가/KPI", subtitle: "내 목표 · 점수 조회")
            }
        }
        .navigationTitle("더보기")
    }
}
