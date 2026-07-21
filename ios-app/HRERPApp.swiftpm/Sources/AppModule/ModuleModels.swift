import Foundation

// 아래 모델들은 server.js의 회계(/api/accounting/*)·영업재고(/api/erp/*)·PMS(/api/pms/*)·
// 채용(/api/recruit/*) REST 엔드포인트를 직접 읽어 확인한 응답 필드에 맞춘 것이다.
// 이 모듈들은 HRDataStore의 "전체 블롭"과 달리 서버가 전용 테이블로 직접 관리하는
// 독립된 REST 리소스라서, 여기서는 일반적인 Decodable 모델을 그대로 써도 데이터 유실
// 위험이 없다(각 엔드포인트가 자기 자신의 레코드만 다루기 때문).

// MARK: - 회계

struct Account: Decodable, Identifiable {
    let id: String
    let code: String
    let name: String
    let type: String
    let category: String?
    let active: Bool?
}

struct VoucherLine: Decodable {
    let accountId: String
    let debit: Double
    let credit: Double
    let memo: String?
}

struct Voucher: Decodable, Identifiable {
    let id: String
    let voucherNo: String?
    let status: String
    let date: String
    let description: String?
    let partner: String?
    let lines: [VoucherLine]
    let amount: Double
    let createdBy: String?
    let createdAt: String
}

// MARK: - 영업/재고

struct InventoryItem: Decodable, Identifiable {
    let id: String
    let code: String
    let name: String
    let unit: String?
    let category: String?
    let safetyStock: Double?
    let unitCost: Double?
    let active: Bool?
}

struct WarehouseLocation: Decodable, Identifiable {
    let id: String
    let name: String
    let address: String?
    let active: Bool?
}

struct TradeDocLine: Decodable {
    let itemId: String?
    let name: String
    let qty: Double
    let unitPrice: Double
    let supplyAmount: Double
    let taxAmount: Double
}

/// 견적서(quotations)와 발주서(purchase_orders)는 문서번호 필드명(quoteNo/poNo)만 다르고
/// 나머지 구조가 동일해 하나의 모델로 공유한다.
struct TradeDocument: Decodable, Identifiable {
    let id: String
    let docNo: String?
    let status: String
    let date: String
    let partnerName: String
    let lines: [TradeDocLine]
    let supplyTotal: Double
    let taxTotal: Double
    let grandTotal: Double
    let memo: String?
    let createdAt: String

    enum CodingKeys: String, CodingKey {
        case id, status, date, partnerName, lines, supplyTotal, taxTotal, grandTotal, memo, createdAt
        case quoteNo, poNo
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        docNo = (try? c.decode(String.self, forKey: .quoteNo)) ?? (try? c.decode(String.self, forKey: .poNo))
        status = try c.decode(String.self, forKey: .status)
        date = try c.decode(String.self, forKey: .date)
        partnerName = try c.decode(String.self, forKey: .partnerName)
        lines = (try? c.decode([TradeDocLine].self, forKey: .lines)) ?? []
        supplyTotal = (try? c.decode(Double.self, forKey: .supplyTotal)) ?? 0
        taxTotal = (try? c.decode(Double.self, forKey: .taxTotal)) ?? 0
        grandTotal = (try? c.decode(Double.self, forKey: .grandTotal)) ?? 0
        memo = try? c.decode(String.self, forKey: .memo)
        createdAt = try c.decode(String.self, forKey: .createdAt)
    }
}

struct StockLevel: Decodable, Identifiable {
    let itemId: String
    let locationId: String
    let qty: Double

    var id: String { "\(itemId)::\(locationId)" }
}

// MARK: - PMS

struct PMSProject: Decodable, Identifiable {
    let id: String
    let name: String
    let startDate: String?
    let endDate: String?
    let status: String
    let memo: String?
    let members: [String]?
}

struct PMSAllocation: Decodable, Identifiable {
    let id: String
    let employeeId: String
    let year: Int
    let month: Int
    let projectId: String
    let percent: Double
    let memo: String?
}

struct NewPMSAllocationPayload: Encodable {
    let employeeId: Int
    let year: Int
    let month: Int
    let projectId: String
    let percent: Double
    let memo: String
}

// MARK: - 채용

struct RecruitJob: Decodable, Identifiable {
    let id: String
    let title: String
    let department: String?
    let team: String?
    let headcount: Int?
    let status: String
    let description: String?
    let stages: [String]?
}

struct RecruitCandidate: Decodable, Identifiable {
    let id: String
    let jobId: String?
    let name: String
    let phone: String?
    let email: String?
    let status: String
    let appliedAt: String?
    let finalEducation: String?
    let resumeSummary: String?
}
