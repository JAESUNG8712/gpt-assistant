import SwiftUI

@MainActor
struct EmployeeDetailView: View {
    let employee: Employee

    var body: some View {
        AppScreen {
            HStack(spacing: 14) {
                ZStack {
                    Circle().fill(AppTheme.accentLight).frame(width: 56, height: 56)
                    Text(String(employee.name.prefix(1)))
                        .font(.title3.weight(.bold))
                        .foregroundStyle(AppTheme.accentDark)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(employee.name).font(.title3.weight(.bold)).foregroundStyle(AppTheme.primaryText)
                    Text([employee.dept, employee.team, employee.position].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                        .font(.caption)
                        .foregroundStyle(AppTheme.secondaryText)
                }
                Spacer()
                if employee.active == false {
                    Text("퇴사").font(.caption.weight(.semibold)).foregroundStyle(AppTheme.secondaryText)
                }
            }

            AppCard(title: "기본 정보") {
                row("사번", employee.empNo)
                row("아이디", employee.loginId)
                row("역할", roleLabel(employee.role))
                row("직군", employee.jobGroup)
                row("직급", employee.rank)
            }

            AppCard(title: "연락처") {
                row("이메일", employee.email)
                row("전화번호", employee.phone)
                row("주소", employee.address)
            }

            AppCard(title: "인사 정보") {
                row("입사일", employee.hire)
                row("생년월일", employee.birth)
                row("성별", employee.gender)
                row("최종학력", employee.edu)
                row("출신학교", employee.eduSchool)
            }
        }
        .navigationTitle(employee.name)
    }

    @ViewBuilder
    private func row(_ label: String, _ value: String?) -> some View {
        if let value, !value.isEmpty {
            LabeledContent(label, value: value)
        }
    }

    private func roleLabel(_ role: String?) -> String? {
        switch role {
        case "admin": return "관리자"
        case "director": return "임원"
        case "leader": return "팀장"
        case "member": return "팀원"
        default: return role
        }
    }
}
