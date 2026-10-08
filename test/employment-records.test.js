const test = require("node:test");
const assert = require("node:assert/strict");
const tools = require("../public/employment-records.js");

test("근로계약은 직원·제목·시작일과 정상 날짜 범위를 요구한다", () => {
  assert.equal(tools.validate({ employeeId: "1", type: "contract", title: "기간제", status: "active", startDate: "2026-01-01", endDate: "2026-12-31" }).ok, true);
  assert.equal(tools.validate({ employeeId: "1", type: "contract", title: "기간제", status: "active", startDate: "2026-12-31", endDate: "2026-01-01" }).ok, false);
  assert.equal(tools.validate({ employeeId: "1", type: "contract", title: "기간제", status: "active", startDate: "2026-02-30" }).ok, false);
});

test("징계 기록은 결정일을 요구한다", () => {
  const result = tools.validate({ employeeId: "1", type: "discipline", title: "견책", status: "closed" });
  assert.equal(result.ok, false); assert.match(result.errors.join(" "), /결정일/);
});

test("만료 요약은 30일 내와 기한 경과를 분리한다", () => {
  const summary = tools.summarize([
    { type: "contract", status: "active", endDate: "2026-10-20" },
    { type: "contract", status: "active", endDate: "2026-09-30" },
    { type: "discipline", status: "active" },
  ], "2026-10-06");
  assert.deepEqual(summary, { total: 3, activeContracts: 2, due30: 1, overdue: 1, activeDiscipline: 1 });
});

test("정규화는 길이를 제한하고 생성 감사 필드를 보존한다", () => {
  const old = { id: "r1", createdAt: "old", createdBy: "a" };
  const row = tools.normalize({ employeeId: "1", type: "discipline", title: "x".repeat(200), status: "closed", decisionDate: "2026-10-01" }, old, { id: "b" }, "now");
  assert.equal(row.title.length, 120); assert.equal(row.createdAt, "old"); assert.equal(row.createdBy, "a"); assert.equal(row.updatedBy, "b");
});
