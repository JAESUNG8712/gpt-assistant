import SwiftUI

@MainActor
struct EmployeeDirectoryView: View {
    @ObservedObject var store: HRDataStore
    let reload: () async -> Void

    @State private var query = ""

    private var filtered: [Employee] {
        let active = store.employees.filter { $0.active != false }
        guard !query.trimmingCharacters(in: .whitespaces).isEmpty else {
            return active.sorted { $0.name < $1.name }
        }
        return active
            .filter {
                $0.name.localizedCaseInsensitiveContains(query)
                    || ($0.dept?.localizedCaseInsensitiveContains(query) ?? false)
                    || ($0.team?.localizedCaseInsensitiveContains(query) ?? false)
            }
            .sorted { $0.name < $1.name }
    }

    var body: some View {
        AppScreen {
            if filtered.isEmpty {
                EmptyState(message: "검색 결과가 없습니다.")
            }
            ForEach(filtered) { employee in
                AppCard {
                    HStack(spacing: 12) {
                        ZStack {
                            Circle().fill(AppTheme.accentLight).frame(width: 36, height: 36)
                            Text(String(employee.name.prefix(1)))
                                .font(.caption.weight(.bold))
                                .foregroundStyle(AppTheme.accentDark)
                        }
                        VStack(alignment: .leading, spacing: 2) {
                            Text(employee.name).font(.subheadline.weight(.semibold))
                            Text([employee.dept, employee.team, employee.position]
                                .compactMap { $0 }
                                .filter { !$0.isEmpty }
                                .joined(separator: " · "))
                                .font(.caption)
                                .foregroundStyle(AppTheme.secondaryText)
                        }
                        Spacer()
                    }
                }
            }
        }
        .searchable(text: $query, prompt: "이름·부서·팀 검색")
        .navigationTitle("조직도 (\(filtered.count)명)")
        .refreshable { await reload() }
    }
}
