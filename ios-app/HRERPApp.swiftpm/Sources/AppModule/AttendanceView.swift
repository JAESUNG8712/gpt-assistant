import SwiftUI

@MainActor
struct AttendanceView: View {
    @EnvironmentObject private var session: SessionStore
    @ObservedObject var store: HRDataStore
    let reload: () async -> Void

    private var myRecords: [AttendanceRecord] {
        guard let empId = session.currentEmployee?.id else { return [] }
        return store.attendanceRecords
            .filter { $0.empId == empId }
            .sorted { $0.date > $1.date }
    }

    var body: some View {
        NavigationStack {
            AppScreen {
                if myRecords.isEmpty {
                    EmptyState(message: "근태 기록이 없습니다.")
                }
                ForEach(myRecords) { record in
                    AppCard {
                        HStack {
                            Text(record.date).font(.subheadline.weight(.semibold))
                            Spacer()
                            if let status = record.status, !status.isEmpty, status != "normal" {
                                StatusPill(status: status)
                            }
                        }
                        HStack(spacing: 16) {
                            Label(record.checkIn?.isEmpty == false ? record.checkIn! : "-", systemImage: "arrow.right.circle")
                            Label(record.checkOut?.isEmpty == false ? record.checkOut! : "-", systemImage: "arrow.left.circle")
                        }
                        .font(.subheadline)
                        .foregroundStyle(AppTheme.secondaryText)
                        if let note = record.note, !note.isEmpty {
                            Text(note).font(.caption).foregroundStyle(AppTheme.secondaryText)
                        }
                    }
                }
            }
            .navigationTitle("내 근태")
            .refreshable { await reload() }
        }
    }
}
