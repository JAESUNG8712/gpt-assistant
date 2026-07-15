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
            List {
                if myRecords.isEmpty {
                    ContentUnavailableFallback(message: "근태 기록이 없습니다.")
                }
                ForEach(myRecords) { record in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text(record.date).font(.headline)
                            Spacer()
                            if let status = record.status, !status.isEmpty, status != "normal" {
                                Text(status)
                                    .font(.caption)
                                    .padding(.horizontal, 6)
                                    .padding(.vertical, 2)
                                    .background(Color.orange.opacity(0.2))
                                    .clipShape(Capsule())
                            }
                        }
                        HStack(spacing: 16) {
                            Label(record.checkIn?.isEmpty == false ? record.checkIn! : "-", systemImage: "arrow.right.circle")
                            Label(record.checkOut?.isEmpty == false ? record.checkOut! : "-", systemImage: "arrow.left.circle")
                        }
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        if let note = record.note, !note.isEmpty {
                            Text(note).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    .padding(.vertical, 2)
                }
            }
            .navigationTitle("내 근태")
            .refreshable { await reload() }
        }
    }
}

/// iOS 17의 ContentUnavailableView 없이도(iOS 16 타깃) 동일한 느낌의 빈 상태 표시.
struct ContentUnavailableFallback: View {
    let message: String

    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: "tray")
                .font(.largeTitle)
                .foregroundStyle(.secondary)
            Text(message)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 40)
        .listRowSeparator(.hidden)
    }
}
