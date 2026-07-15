import SwiftUI

@MainActor
struct DashboardView: View {
    @EnvironmentObject private var settings: AppSettings
    @EnvironmentObject private var session: SessionStore
    @ObservedObject var store: HRDataStore
    let reload: () async -> Void

    @State private var isSavingAttendance = false

    private var client: APIClient { APIClient(settings: settings) }

    private var todayRecord: AttendanceRecord? {
        guard let empId = session.currentEmployee?.id else { return nil }
        let today = DateHelpers.todayDateString()
        return store.attendanceRecords.first { $0.empId == empId && $0.date == today }
    }

    private var pendingApprovalCount: Int {
        guard let empId = session.currentEmployee?.id else { return 0 }
        return store.approvalDocs.filter { doc in
            doc.status == "in_progress" && doc.approvers.contains { $0.empId == empId && $0.status == "pending" }
        }.count
    }

    var body: some View {
        NavigationStack {
            List {
                if let employee = session.currentEmployee {
                    Section("내 정보") {
                        LabeledContent("이름", value: employee.name)
                        if let dept = employee.dept, !dept.isEmpty {
                            LabeledContent("부서", value: [dept, employee.team].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                        }
                        if let position = employee.position, !position.isEmpty {
                            LabeledContent("직위", value: position)
                        }
                    }
                }

                Section("오늘 근태 (\(DateHelpers.todayDateString()))") {
                    let record = todayRecord
                    let checkedIn = !(record?.checkIn ?? "").isEmpty
                    let checkedOut = !(record?.checkOut ?? "").isEmpty

                    LabeledContent("출근", value: checkedIn ? record!.checkIn! : "-")
                    LabeledContent("퇴근", value: checkedOut ? record!.checkOut! : "-")
                    HStack {
                        Button("출근 체크") { Task { await checkIn() } }
                            .buttonStyle(.borderedProminent)
                            .disabled(isSavingAttendance || checkedIn)
                        Button("퇴근 체크") { Task { await checkOut() } }
                            .buttonStyle(.bordered)
                            .disabled(isSavingAttendance || checkedOut)
                    }
                }

                Section("요약") {
                    LabeledContent("내가 처리할 결재", value: "\(pendingApprovalCount)건")
                    LabeledContent("전체 직원", value: "\(store.employees.count)명")
                    if let lastLoaded = store.lastLoadedAt {
                        LabeledContent("마지막 동기화", value: lastLoaded.formatted(date: .omitted, time: .shortened))
                    }
                }

                if let error = store.lastError {
                    Section {
                        Text(error).font(.footnote).foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("홈")
            .refreshable { await reload() }
            .overlay {
                if store.isLoading && store.lastLoadedAt == nil {
                    ProgressView()
                }
            }
        }
    }

    private func checkIn() async {
        guard let empId = session.currentEmployee?.id else { return }
        isSavingAttendance = true
        defer { isSavingAttendance = false }
        store.checkIn(empId: empId, date: DateHelpers.todayDateString(), time: DateHelpers.nowTimeString())
        await store.save(client: client, session: session)
    }

    private func checkOut() async {
        guard let empId = session.currentEmployee?.id else { return }
        isSavingAttendance = true
        defer { isSavingAttendance = false }
        store.checkOut(empId: empId, date: DateHelpers.todayDateString(), time: DateHelpers.nowTimeString())
        await store.save(client: client, session: session)
    }
}
