// public/payslip-calc.js(클라이언트·서버 공용 급여 계산) 단위 테스트.
// 손계산한 값과 대조해 계산식이 바뀌면 바로 드러나도록 고정한다.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const PayslipCalc = require("../public/payslip-calc.js");

const base = (over = {}) => ({ id: "e1", name: "홍길동", dept: "개발본부", team: "A팀", rank: "대리", position: "팀원", salary: 60000000, ...over });
const ctx = (over = {}) => ({ settings: {}, payrollAdjustments: [], overtimeRequests: [], wageGarnishments: [], attendanceRecords: [], ...over });

test("연봉제 기본 계산 — 4대보험·소득세·지방소득세가 손계산과 일치", () => {
  // 연봉 6,000만원 → 월 기본급 500만원 + 교통비 10만원 = 510만원(과세), 식대 20만원(비과세)
  const s = PayslipCalc.calcStandardPayslip(base(), 2026, 5, ctx());
  assert.equal(s.monthly, 5100000);
  assert.equal(s.gross, 5300000);
  assert.equal(s.taxableIncome, 5100000);
  assert.equal(s.pension, 229500);   // 4.5%
  assert.equal(s.health, 180795);    // 3.545%
  assert.equal(s.care, 23103);       // 0.453%
  assert.equal(s.employ, 45900);     // 0.9%
  assert.equal(s.tax, 765000);       // 과세표준 500만원 이상 15%
  assert.equal(s.localTax, 76500);   // 소득세의 10%
  assert.equal(s.totalDeduct, 1320798);
  assert.equal(s.netPay, 3979202);
  assert.equal(s.id, "payslip-e1-2026-5");
});

test("R&BD센터 연구수당은 기본급에서 빼고 비과세로 따로 지급", () => {
  const s = PayslipCalc.calcStandardPayslip(base({ dept: "R&BD센터" }), 2026, 5, ctx());
  assert.equal(s.researchAllow, 200000);
  assert.equal(s.monthly, 4900000);  // 500만 - 연구수당 20만 + 교통비 10만
  assert.equal(s.gross, 5300000);    // 4,900,000 + 식대 200,000 + 연구수당 200,000
  assert.equal(s.tax, 294000);       // 과세표준 490만원 → 6%
});

test("팀장은 직책수당 50만원이 과세 지급에 추가된다", () => {
  const s = PayslipCalc.calcStandardPayslip(base({ position: "팀장" }), 2026, 5, ctx());
  assert.equal(s.posAllow, 500000);
  assert.equal(s.taxableIncome, 5600000);
  assert.ok(s.payItems.some(it => it.label === "직책수당" && it.amount === 500000));
});

test("호봉제 — 직급·직급연차 표의 금액을 쓰고, 표가 없으면 연봉제로 폴백", () => {
  const stepCtx = ctx({ settings: { payBasisMode: "step", salaryStepTable: { "대리": [3000000, 3200000, 3400000] } } });
  // 직급연차 2 → 두 번째 호봉 320만원 + 교통비 10만원 = 330만원(과세, 6%)
  const s = PayslipCalc.calcStandardPayslip(base({ rankYear: 2 }), 2026, 5, stepCtx);
  assert.equal(s.monthly, 3300000);
  assert.equal(s.tax, 198000);
  // 표 길이를 넘는 호봉은 마지막 호봉 금액 적용(호봉 상한)
  const capped = PayslipCalc.calcStandardPayslip(base({ rankYear: 9 }), 2026, 5, stepCtx);
  assert.equal(capped.monthly, 3500000);
  // 해당 직급 행이 없으면 연봉제 계산으로 폴백 (0원이 되지 않음)
  const fallback = PayslipCalc.calcStandardPayslip(base({ rank: "과장", rankYear: 1 }), 2026, 5, stepCtx);
  assert.equal(fallback.monthly, 5100000);
});

test("회사 커스텀 수당은 대상·적용기간이 맞을 때만 반영된다", () => {
  const items = [
    { id: "c1", name: "자격수당", type: "pay", calcType: "fixed", amount: 100000, targetType: "dept", targetValue: "개발본부", enabled: true, taxable: true },
    { id: "c2", name: "다른부서수당", type: "pay", calcType: "fixed", amount: 300000, targetType: "dept", targetValue: "영업본부", enabled: true },
    { id: "c3", name: "기간외수당", type: "pay", calcType: "fixed", amount: 50000, targetType: "all", startMonth: "2026-06", enabled: true },
  ];
  const s = PayslipCalc.calcStandardPayslip(base(), 2026, 5, ctx({ settings: { customPayItems: items } }));
  assert.equal(s.customPay, 100000);
  assert.ok(s.payItems.some(it => it.label === "자격수당"));
  assert.ok(!s.payItems.some(it => it.label === "다른부서수당" || it.label === "기간외수당"));
});

test("승인된 초과근무는 시급 × 가산율로 반영되고, 임원은 연장근로수당 대상이 아니다", () => {
  const otCtx = ctx({ overtimeRequests: [{ empId: "e1", status: "approved", date: "2026-05-10", hours: 10, type: "연장" }] });
  const s = PayslipCalc.calcStandardPayslip(base(), 2026, 5, otCtx);
  // 시급 = round(5,100,000 / 209) = 24,402, 연장 1.5배 × 10h = 366,030
  assert.equal(s.hourlyWage, 24402);
  assert.ok(s.payItems.some(it => it.label.startsWith("초과근무수당") && it.amount === 366030));

  const exec = PayslipCalc.calcStandardPayslip(base({ rank: "상무" }), 2026, 5, otCtx);
  assert.equal(exec.overtimeAllowance, 0);
  assert.ok(!exec.payItems.some(it => it.label.startsWith("초과근무수당")));
});

test("급여 압류 — 비율형은 과세 후 실수령액 기준, 취소·기간외 건은 제외", () => {
  const garn = [
    { id: "g1", empId: "e1", type: "percentOfNet", rate: 10, caseNumber: "2026가단1", status: "active" },
    { id: "g2", empId: "e1", type: "fixed", amount: 100000, status: "canceled" },
    { id: "g3", empId: "e1", type: "fixed", amount: 50000, status: "active", startMonth: "2026-06" },
  ];
  const s = PayslipCalc.calcStandardPayslip(base(), 2026, 5, ctx({ wageGarnishments: garn }));
  // 공제 전 실수령(3,979,202)의 10% = 397,920
  assert.equal(s.garnishDeduct, 397920);
  assert.equal(s.totalDeduct, 1320798 + 397920);
  assert.ok(s.deductItems.some(it => it.label === "급여압류(2026가단1)" && it.amount === 397920));
});

test("급여 조정 — 같은 달 항목만 지급/공제로 나뉘어 반영된다", () => {
  const adj = [
    { id: "a1", empId: "e1", year: 2026, month: 5, amount: 200000, category: "인센티브", taxable: true },
    { id: "a2", empId: "e1", year: 2026, month: 4, amount: 999999, category: "다른달" },
    { id: "a3", empId: "e1", year: 2026, month: 5, amount: -30000, category: "가불 정산" },
  ];
  const s = PayslipCalc.calcStandardPayslip(base(), 2026, 5, ctx({ payrollAdjustments: adj }));
  assert.equal(s.adjustPay, 200000);
  assert.equal(s.adjustDeduct, 30000);
  assert.ok(!s.payItems.some(it => it.label === "다른달"));
});

test("근태 기록으로 정규/연장 근무시간을 계산한다(휴게 1시간 차감)", () => {
  const att = [
    { empId: "e1", date: "2026-05-04", checkIn: "09:00", checkOut: "19:00" }, // 10h-1h = 9h → 정규 8h + 연장 1h
    { empId: "e1", date: "2026-05-05", checkIn: "09:00", checkOut: "18:00" }, // 8h → 정규 8h
    { empId: "e2", date: "2026-05-05", checkIn: "09:00", checkOut: "18:00" }, // 다른 직원 무시
  ];
  const r = PayslipCalc.calcMonthlyWorkHours("e1", 2026, 5, { settings: { workStartHour: 9, workEndHour: 18 }, attendanceRecords: att });
  assert.equal(r.stdDailyHours, 8);
  assert.equal(r.regularHours, 16);
  assert.equal(r.overtimeHours, 1);
});
