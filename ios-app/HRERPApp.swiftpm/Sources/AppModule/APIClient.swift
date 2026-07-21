import Foundation

/// server.js(HR/ERP 시스템)용 REST 클라이언트.
/// 인증: POST /login → Bearer 토큰, 이후 모든 요청에 Authorization 헤더로 전달.
/// 핵심 데이터는 "클라이언트 신뢰형 전체 상태 블롭"(GET /data · POST /save) 패턴이라
/// 정적 타입 대신 JSONSerialization 기반 [String: Any]로 다룬다 — 이 앱이 모르는
/// 필드(coreTalentPool, orgDB, settings 등 20개 이상)까지 포함해 있는 그대로 보존해야
/// POST /save 시 데이터 유실이 없다.
final class APIClient {
    private let settings: AppSettings
    private let session: URLSession

    init(settings: AppSettings) {
        self.settings = settings
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 30
        self.session = URLSession(configuration: config)
    }

    private func url(_ path: String) throws -> URL {
        guard let base = settings.baseURL else { throw APIError.invalidURL }
        return base.appendingPathComponent(path)
    }

    // MARK: POST /login

    func login(loginId: String, password: String, otp: String?) async throws -> LoginResponse {
        var request = URLRequest(url: try url("login"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var body: [String: String] = ["loginId": loginId, "pw": password]
        if let otp, !otp.isEmpty { body["otp"] = otp }
        request.httpBody = try JSONEncoder().encode(body)

        let (data, response) = try await session.data(for: request)
        try Self.checkResponse(response, data: data)
        return try JSONDecoder().decode(LoginResponse.self, from: data)
    }

    // MARK: GET /data

    func fetchData(token: String) async throws -> (data: [String: Any], version: Int) {
        var request = URLRequest(url: try url("data"))
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        let (raw, response) = try await session.data(for: request)
        try Self.checkResponse(response, data: raw)

        guard let object = try JSONSerialization.jsonObject(with: raw) as? [String: Any],
              let data = object["data"] as? [String: Any] else {
            throw APIError.serverError(0, "GET /data 응답 형식이 올바르지 않습니다.")
        }
        let version = (object["version"] as? Int) ?? 0
        return (data, version)
    }

    // MARK: POST /save

    struct SaveResult {
        let version: Int
        let merged: Bool
        let mergedData: [String: Any]?
    }

    func saveData(_ data: [String: Any], version: Int, token: String) async throws -> SaveResult {
        var request = URLRequest(url: try url("save"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let body: [String: Any] = ["_version": version, "data": data]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (raw, response) = try await session.data(for: request)
        try Self.checkResponse(response, data: raw)

        guard let object = try JSONSerialization.jsonObject(with: raw) as? [String: Any] else {
            throw APIError.serverError(0, "POST /save 응답 형식이 올바르지 않습니다.")
        }
        let newVersion = (object["version"] as? Int) ?? version
        let merged = (object["merged"] as? Bool) ?? false
        let mergedData = object["mergedData"] as? [String: Any]
        return SaveResult(version: newVersion, merged: merged, mergedData: mergedData)
    }

    // MARK: GET /status (인증 불필요 — 로그인 화면에서 서버 연결 확인용)

    func checkStatus() async throws -> [String: Any] {
        let (raw, response) = try await session.data(from: try url("status"))
        try Self.checkResponse(response, data: raw)
        return (try? JSONSerialization.jsonObject(with: raw) as? [String: Any]) ?? [:]
    }

    // MARK: - 직원 관리(관리자 전용): 신규 등록용 원자적 id 발급
    // 여러 관리자가 거의 동시에 신규 직원을 등록할 때 클라이언트가 각자 마지막으로 받은
    // GET /data 스냅샷 기준으로 id를 만들면 충돌해서 한쪽이 사라진다(서버 쪽 실측 기록:
    // 30명 동시 등록 시 27명 유실) — 서버가 원자적으로 발급하는 이 엔드포인트를 반드시 써야 한다.

    func nextEmployeeId(token: String) async throws -> Int {
        var request = URLRequest(url: try url("api/employees/next-id"))
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await session.data(for: request)
        try Self.checkResponse(response, data: data)
        struct Response: Decodable { let ok: Bool; let id: Int }
        return try JSONDecoder().decode(Response.self, from: data).id
    }

    // MARK: - 회계 / 영업재고 / PMS / 채용
    // 위 GET /data 블롭과 달리 이 엔드포인트들은 서버가 전용 테이블로 직접 관리하는
    // 독립 리소스라, 일반 Decodable로 디코드해도 데이터 유실 위험이 없다.

    func fetchAccounts(token: String) async throws -> [Account] {
        try await decodeList("api/accounting/accounts", token: token, rootKey: "accounts")
    }

    func fetchVouchers(token: String) async throws -> [Voucher] {
        try await decodeList("api/accounting/vouchers", token: token, rootKey: "vouchers")
    }

    /// 관리자 전용(서버가 `requireAdmin`으로 검증). `id`를 넘기면 그 계정을 수정(upsert),
    /// 넘기지 않으면 서버가 새 id를 발급해 신규 등록한다.
    func saveAccount(
        id: String?, code: String, name: String, type: String, category: String, active: Bool, user: String, token: String
    ) async throws -> Account {
        var request = URLRequest(url: try url("api/accounting/accounts"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        struct Body: Encodable {
            let id: String?; let code: String; let name: String
            let type: String; let category: String; let active: Bool; let user: String
        }
        request.httpBody = try JSONEncoder().encode(
            Body(id: id, code: code, name: name, type: type, category: category, active: active, user: user)
        )
        let (data, response) = try await session.data(for: request)
        try Self.checkResponse(response, data: data)
        struct Response: Decodable { let ok: Bool; let account: Account }
        return try JSONDecoder().decode(Response.self, from: data).account
    }

    /// 전표에서 사용 중인 계정과목은 서버가 삭제를 거부하고 400을 반환한다(비활성화를 대신 안내).
    func deleteAccount(id: String, token: String) async throws {
        var request = URLRequest(url: try url("api/accounting/accounts/\(id)/delete"))
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await session.data(for: request)
        try Self.checkResponse(response, data: data)
    }

    /// 임시(draft) 전표를 확정한다 — 확정돼야 정식 전표번호(voucherNo)가 붙는다.
    func postVoucher(id: String, user: String, token: String) async throws -> Voucher {
        var request = URLRequest(url: try url("api/accounting/vouchers/\(id)/post"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.httpBody = try JSONEncoder().encode(["user": user])
        let (data, response) = try await session.data(for: request)
        try Self.checkResponse(response, data: data)
        struct Response: Decodable { let ok: Bool; let voucher: Voucher }
        return try JSONDecoder().decode(Response.self, from: data).voucher
    }

    /// 확정된(posted) 전표만 취소할 수 있다 — 임시(draft) 전표는 `deleteVoucher`로 지운다.
    func voidVoucher(id: String, reason: String, user: String, token: String) async throws -> Voucher {
        var request = URLRequest(url: try url("api/accounting/vouchers/\(id)/void"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        struct Body: Encodable { let reason: String; let user: String }
        request.httpBody = try JSONEncoder().encode(Body(reason: reason, user: user))
        let (data, response) = try await session.data(for: request)
        try Self.checkResponse(response, data: data)
        struct Response: Decodable { let ok: Bool; let voucher: Voucher }
        return try JSONDecoder().decode(Response.self, from: data).voucher
    }

    /// 임시(draft) 상태의 전표만 삭제할 수 있다(확정된 전표는 `voidVoucher`로 취소).
    func deleteVoucher(id: String, token: String) async throws {
        var request = URLRequest(url: try url("api/accounting/vouchers/\(id)"))
        request.httpMethod = "DELETE"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await session.data(for: request)
        try Self.checkResponse(response, data: data)
    }

    struct NewVoucherLine: Encodable {
        let accountId: String
        let debit: Double
        let credit: Double
        let memo: String
    }

    /// 관리자 전용(서버가 `requireAdmin`으로 검증). 생성된 전표는 "임시(draft)" 상태이며
    /// 별도 확정(post) 절차가 있어야 정식 전표번호(voucherNo)가 붙는다 — index.html의
    /// openExpensePayModal()/payExpenseClaim() 주석과 동일.
    func createVoucher(
        date: String, description: String, partner: String,
        lines: [NewVoucherLine], role: String, user: String, token: String
    ) async throws -> Voucher {
        var request = URLRequest(url: try url("api/accounting/vouchers"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        struct Body: Encodable {
            let date: String; let description: String; let partner: String
            let lines: [NewVoucherLine]; let role: String; let user: String
        }
        request.httpBody = try JSONEncoder().encode(
            Body(date: date, description: description, partner: partner, lines: lines, role: role, user: user)
        )
        let (data, response) = try await session.data(for: request)
        try Self.checkResponse(response, data: data)
        struct Response: Decodable { let ok: Bool; let voucher: Voucher }
        return try JSONDecoder().decode(Response.self, from: data).voucher
    }

    func fetchItems(token: String) async throws -> [InventoryItem] {
        try await decodeList("api/erp/items", token: token, rootKey: "items")
    }

    func fetchLocations(token: String) async throws -> [WarehouseLocation] {
        try await decodeList("api/erp/locations", token: token, rootKey: "locations")
    }

    func fetchQuotations(token: String) async throws -> [TradeDocument] {
        try await decodeList("api/erp/quotations", token: token, rootKey: "quotations")
    }

    func fetchPurchaseOrders(token: String) async throws -> [TradeDocument] {
        try await decodeList("api/erp/purchase-orders", token: token, rootKey: "purchaseOrders")
    }

    func fetchStock(token: String) async throws -> [StockLevel] {
        try await decodeList("api/erp/stock", token: token, rootKey: "stock")
    }

    func fetchPMSProjects(token: String) async throws -> [PMSProject] {
        try await decodeList("api/pms/projects", token: token, rootKey: "projects")
    }

    func fetchPMSAllocations(token: String) async throws -> [PMSAllocation] {
        try await decodeList("api/pms/allocations", token: token, rootKey: "allocations")
    }

    func createPMSAllocation(_ payload: NewPMSAllocationPayload, token: String) async throws {
        var request = URLRequest(url: try url("api/pms/allocations"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.httpBody = try JSONEncoder().encode(payload)

        let (data, response) = try await session.data(for: request)
        try Self.checkResponse(response, data: data)
    }

    func fetchRecruitJobs(token: String) async throws -> [RecruitJob] {
        try await decodeList("api/recruit/jobs", token: token, rootKey: "jobs")
    }

    func fetchRecruitCandidates(token: String) async throws -> [RecruitCandidate] {
        try await decodeList("api/recruit/candidates", token: token, rootKey: "candidates")
    }

    private func decodeList<T: Decodable>(_ path: String, token: String, rootKey: String) async throws -> [T] {
        var request = URLRequest(url: try url(path))
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        let (raw, response) = try await session.data(for: request)
        try Self.checkResponse(response, data: raw)

        guard let object = try JSONSerialization.jsonObject(with: raw) as? [String: Any] else {
            throw APIError.serverError(0, "\(path) 응답 형식이 올바르지 않습니다.")
        }
        guard let array = object[rootKey] as? [[String: Any]] else { return [] }
        // 레코드 하나가 예상 형식과 안 맞아도(서버 스키마 변경, 부분 null 등) 그 항목만
        // 건너뛰고 나머지는 정상 표시한다 — 예전엔 [T].self로 배열 전체를 한 번에 디코드해서
        // 항목 하나만 깨져도 전체 목록이 통째로 실패했다(HRDataStore.decodeArray와 동일 패턴).
        return array.compactMap { dict in
            guard let data = try? JSONSerialization.data(withJSONObject: dict) else { return nil }
            return try? JSONDecoder().decode(T.self, from: data)
        }
    }

    private static func checkResponse(_ response: URLResponse, data: Data) throws {
        guard let http = response as? HTTPURLResponse else { return }
        guard (200..<300).contains(http.statusCode) else {
            throw APIError.fromResponse(statusCode: http.statusCode, data: data)
        }
    }
}
