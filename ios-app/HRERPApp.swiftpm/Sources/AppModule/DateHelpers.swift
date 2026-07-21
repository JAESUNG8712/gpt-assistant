import Foundation

/// public/index.html의 근태 기록 방식과 정확히 맞추기 위한 포맷.
/// date는 `new Date().toISOString().slice(0,10)`(UTC 기준), time은 로컬 시각 `HH:mm` —
/// 원본 웹앱과 동일한(다소 특이한) 규칙을 그대로 따라야 기존 레코드와 날짜가 어긋나지 않는다.
enum DateHelpers {
    static func todayDateString() -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.timeZone = TimeZone(identifier: "UTC")
        return formatter.string(from: Date())
    }

    static func nowTimeString() -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm"
        formatter.timeZone = .current
        return formatter.string(from: Date())
    }
}
