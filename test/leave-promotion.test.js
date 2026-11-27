// 연차 사용촉진 계산(lib/leave-promotion.js) 단위 테스트. 기대값은 클라이언트 calcAnnualLeaveGrant /
// calcLeaveUsed 규칙을 손으로 계산한 값이다(두 구현이 어긋나지 않는지 확인하는 기준표).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const L = require("../lib/leave-promotion");

test("연차 기본 부여: 1년 미만은 매월 1일(최대 11), 1년 이상은 15일 + 2년마다 1일(최대 25)", () => {
  // 1주년 전날 vs 당일 (경계)
  assert.equal(L.annualLeaveGrant({ hire: "2025-11-26" }, "2026-11-25"), 11);
  assert.equal(L.annualLeaveGrant({ hire: "2025-11-25" }, "2026-11-25"), 15);
  // 6년차: 15 + floor(5/2) = 17
  assert.equal(L.annualLeaveGrant({ hire: "2020-01-15" }, "2026-11-25"), 17);
  // 매우 오래된 입사자는 25일에서 멈춘다
  assert.equal(L.annualLeaveGrant({ hire: "1990-01-01" }, "2026-11-25"), 25);
  // 입사일 없음 → 0
  assert.equal(L.annualLeaveGrant({}, "2026-11-25"), 0);
});

test("연차 조정(leaveAdjust)은 같은 연도 항목만 더하고 총합은 0 미만이 되지 않는다", () => {
  const emp = { hire: "2020-01-15", leaveAdjust: [{ year: 2026, days: 2 }, { year: 2025, days: 9 }, { year: 2026, days: -3 }] };
  assert.equal(L.totalLeaveGrant(emp, 2026, "2026-11-25"), 16); // 17 + 2 - 3
  assert.equal(L.totalLeaveGrant({ hire: "2020-01-15", leaveAdjust: [{ year: 2026, days: -99 }] }, 2026, "2026-11-25"), 0);
});

test("승인된 연차 사용량: 연차는 days(countsAnnual=false 제외), 반차는 0.5일, 다른 작성자·미승인 문서는 제외", () => {
  const docs = [
    { authorId: "e1", status: "approved", templateId: "tpl-vacation", formData: { days: 3 } },
    { authorId: "e1", status: "approved", templateId: "tpl-vacation", formData: { days: 2, countsAnnual: false } },
    { authorId: "e1", status: "approved", templateId: "tpl-halfday" },
    { authorId: "e1", status: "in_progress", templateId: "tpl-vacation", formData: { days: 5 } },
    { authorId: "e2", status: "approved", templateId: "tpl-vacation", formData: { days: 4 } },
  ];
  assert.equal(L.leaveUsed("e1", docs), 3.5);
  assert.equal(L.leaveUsed("e2", docs), 4);
  assert.equal(L.leaveUsed("nobody", docs), 0);
});

test("통보 기간: 1차 07-01~07-10, 2차 11-01~11-10만 해당하고 경계 바깥은 제외", () => {
  assert.deepEqual(L.promotionWindow("2026-07-01"), { round: 1, year: 2026 });
  assert.deepEqual(L.promotionWindow("2026-07-10"), { round: 1, year: 2026 });
  assert.equal(L.promotionWindow("2026-07-11"), null);
  assert.equal(L.promotionWindow("2026-06-30"), null);
  assert.deepEqual(L.promotionWindow("2026-11-01"), { round: 2, year: 2026 });
  assert.deepEqual(L.promotionWindow("2026-11-10"), { round: 2, year: 2026 });
  assert.equal(L.promotionWindow("2026-11-11"), null);
  assert.equal(L.promotionWindow("not-a-date"), null);
});

test("대상 선정: 재직·잔여 1일 이상만, 발송 기록 id는 연도·차수·직원으로 고정", () => {
  const employees = [
    { id: "e1", name: "잔여있음", email: "a@x.test", active: true, hire: "2020-01-15" },
    { id: "e2", name: "전부사용", email: "b@x.test", active: true, hire: "2020-01-15", leaveAdjust: [{ year: 2026, days: -17 }] },
    { id: "e3", name: "퇴직자", email: "c@x.test", active: false, hire: "2020-01-15" },
    { id: "e4", name: "신입", email: "", active: true, hire: "2026-10-01" }, // 기본 부여 1일 → 대상(이메일 검사는 호출부 책임)
  ];
  const docs = [{ authorId: "e1", status: "approved", templateId: "tpl-vacation", formData: { days: 15 } }];
  const targets = L.computeLeavePromotionTargets(employees, docs, "2026-11-02");
  assert.deepEqual(targets.map(t => t.empId), ["e1", "e4"]);
  const e1 = targets.find(t => t.empId === "e1");
  assert.equal(e1.noticeId, "lpn-2026-2-e1");
  assert.equal(e1.round, 2);
  assert.equal(e1.remain, 2); // 17 - 15
  // 통보 기간이 아니면 대상 없음
  assert.deepEqual(L.computeLeavePromotionTargets(employees, docs, "2026-09-15"), []);
});
