// computeBusinessPlanProjection()(budget.js) 회귀 테스트. 2026-08-24 병렬 QA 감사
// 에이전트가 발견: 프로젝션 루프가 y=1부터 시작해 첫 행을 "baseYear+1"로 라벨링하면서
// 성장률도 이미 1회 복리 적용된 값으로 계산하고 있었다 — 기준연도(baseYear) 자신은
// P&L 표에 전혀 나타나지 않고, 1년짜리 계획(예: 예산 업로드로 자동생성되는 costOnly
// 계획)조차 실제로는 다음 해로 밀려서 표시됐다. 같은 계획 카드의 BEP 분석 박스는
// "기준연도 {baseYear}"를 올바르게 표시하고 있어, 화면 하나에 서로 모순되는 연도
// 라벨이 함께 떴다. y=0(기준연도, 성장률 미적용)부터 시작하도록 수정했다.
//
// mkdtemp의 DATA_FILE, 랜덤 PORT, child process `node server.js`만 사용 — 실제 DB나
// 운영 데이터 파일은 이 테스트가 존재하는지조차 모른다.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer, bootstrapAdminAndLogin } = require("./support/start-server");

function auth(token, method, body) {
  return {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  };
}

test("사업계획 P&L 프로젝션이 기준연도(baseYear) 자신을 첫 행으로 정확히 포함한다", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const api = (path, options) => fetch(server.baseUrl + path, options);

  const boot = await bootstrapAdminAndLogin(server, { loginId: "admin", pw: "admin-test-pw-1", name: "관리자" });
  const adminToken = boot.token;

  await t.test("1년짜리(costOnly) 계획은 기준연도 자신 한 줄만 나온다(밀리지 않음)", async () => {
    const r = await api("/api/budget/business-plan", auth(adminToken, "POST", {
      name: "2027년 예산", baseYear: 2027, years: 1, planType: "costOnly", dept: "개발본부", team: "개발1팀",
    }));
    assert.equal(r.status, 200);
    const plan = (await r.json()).plan;
    assert.deepEqual(plan.projection.map(p => p.year), [2027]);
  });

  await t.test("3년 매출계획 — 연도 라벨과 복리 성장 값이 기준연도부터 정확히 계산된다", async () => {
    const r = await api("/api/budget/business-plan", auth(adminToken, "POST", {
      name: "3년 매출계획", baseYear: 2030, years: 3, planType: "revenue", dept: "영업본부", team: "영업1팀",
      baseRevenue: 1000000, revenueGrowthRate: 0.1, cogsRatio: 0.5, taxRate: 0.2,
    }));
    assert.equal(r.status, 200);
    const plan = (await r.json()).plan;
    assert.deepEqual(plan.projection.map(p => p.year), [2030, 2031, 2032]);
    assert.deepEqual(plan.projection.map(p => p.revenue), [1000000, 1100000, 1210000]);
    // 같은 계획 카드 안의 BEP 분석과 P&L 표 첫 행의 연도가 서로 일치해야 한다
    // (수정 전에는 BEP="기준연도 2030" vs P&L 첫 칼럼="2031"로 서로 모순됐다).
    assert.equal(plan.breakEven.baseYear, plan.projection[0].year);
  });

  await t.test("판관비 항목별 성장률도 기준연도(y=0)에는 미적용, 이후 정확히 복리 적용된다", async () => {
    const r = await api("/api/budget/business-plan", auth(adminToken, "POST", {
      name: "판관비성장률계획", baseYear: 2028, years: 2, planType: "revenue", dept: "IT본부", team: "IT1팀",
      baseRevenue: 5000000, revenueGrowthRate: 0, cogsRatio: 0, taxRate: 0,
      sgaItems: [{ name: "통신비", baseAmount: 100000, growthRate: 0.2, accountType: "판관" }],
    }));
    assert.equal(r.status, 200);
    const plan = (await r.json()).plan;
    assert.deepEqual(plan.projection.map(p => p.sga), [100000, 120000]);
  });
});
