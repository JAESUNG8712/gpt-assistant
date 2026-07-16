import SwiftUI

/// 근태·전자결재·경비청구·홈처럼 자주 쓰는 화면은 하단 탭에 바로 두고, 그 외 모듈
/// (조직도·회계·영업재고·PMS·채용)은 이 허브에서 카드로 진입한다 — 탭이 6개를
/// 넘어가면 iPad에서도 UX가 나빠지므로, "실사용 앱"처럼 자주 쓰는 것과 가끔 쓰는 것을
/// 구분했다.
@MainActor
struct ERPHubView: View {
    @ObservedObject var store: HRDataStore
    let reload: () async -> Void

    var body: some View {
        NavigationStack {
            AppScreen {
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
            }
            .navigationTitle("더보기")
        }
    }
}
