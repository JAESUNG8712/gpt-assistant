import SwiftUI

/// kpiEntries(자기평가→1차→2차→최종확정 다면평가)는 GET /data 블롭의 일부라 근태·결재와
/// 같은 방식으로 읽는다. 목표 작성/점수 입력 등 쓰기 워크플로 전체는 범위 밖 — 이미 입력된
/// 값을 보여주기만 하는 읽기 전용 화면이다.
@MainActor
struct KPIView: View {
    @EnvironmentObject private var session: SessionStore
    @ObservedObject var store: HRDataStore
    let reload: () async -> Void

    private var myEntries: [KPIEntry] {
        guard let empId = session.currentEmployee?.id else { return [] }
        return store.kpiEntries
            .filter { $0.userId == empId }
            .sorted { ($0.year ?? 0) > ($1.year ?? 0) }
    }

    var body: some View {
        AppScreen {
            if myEntries.isEmpty {
                EmptyState(message: "등록된 평가 목표가 없습니다.")
            }
            ForEach(myEntries) { entry in
                AppCard {
                    HStack {
                        Text(entry.item).font(.subheadline.weight(.semibold))
                        Spacer()
                        if let year = entry.year {
                            Text("\(year)년").font(.caption).foregroundStyle(AppTheme.secondaryText)
                        }
                    }
                    if let goal = entry.goal, !goal.isEmpty {
                        Text(goal).font(.caption).foregroundStyle(AppTheme.secondaryText)
                    }
                    HStack(spacing: 16) {
                        scoreLabel("자기", entry.selfScore)
                        scoreLabel("1차", entry.firstScore)
                        scoreLabel("2차", entry.secondScore)
                        scoreLabel("최종", entry.finalScore)
                        Spacer()
                        if entry.isDraft == true {
                            Text("초안").font(.caption).foregroundStyle(AppTheme.warning)
                        }
                    }
                }
            }
        }
        .navigationTitle("평가 / KPI")
        .refreshable { await reload() }
    }

    @ViewBuilder
    private func scoreLabel(_ label: String, _ score: Double?) -> some View {
        VStack(spacing: 2) {
            Text(label).font(.caption2).foregroundStyle(AppTheme.secondaryText)
            Text(score.map { String(format: "%.1f", $0) } ?? "-").font(.caption.weight(.semibold))
        }
    }
}
