"use strict";

// 사업계획 매출 실적 입력(revenue-actuals)·계획 대비 실적 리포트(revenue-monitor)·
// 부문별/전사 롤업(rollup.revenueRollup)의 서버 규칙 회귀 테스트.
// mkdtemp의 DATA_FILE, 랜덤 PORT, child process `node server.js`만 사용한다.
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

const months = (v) => Array(12).fill(v);

test("매출 실적 입력·모니터링·롤업", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const api = (path, options) => fetch(server.baseUrl + path, options);
  const B = "/api/budget/business-plan";

  const boot = await bootstrapAdminAndLogin(server, { loginId: "admin", pw: "admin-test-pw-1", name: "관리자" });
  const admin = boot.token;
  const initial = await (await api("/data", { headers: { Authorization: `Bearer ${admin}` } })).json();
  const mk = (id, role, dept, team) => ({ id, loginId: id, pw: `${id}-pw-1234`, name: id, role, active: true, dept, team });
  const employees = [
    ...initial.data.employees,
    mk("memA", "member", "영업본부", "영업1팀"),
    mk("memB", "member", "개발본부", "개발1팀"),
    mk("dirA", "director", "영업본부", ""),
    mk("dirB", "director", "개발본부", ""),
  ];
  assert.equal((await api("/save", auth(admin, "POST", { _version: initial.version, employees }))).status, 200);
  const tok = {};
  for (const id of ["memA", "memB", "dirA", "dirB"]) {
    const r = await (await api("/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ loginId: id, pw: `${id}-pw-1234` }) })).json();
    assert.equal(r.ok, true, id);
    tok[id] = r.token;
  }
  assert.equal((await api(B + "/settings/input-window", auth(admin, "POST", { inputOpen: true }))).status, 200);

  const revItem = { id: "rev1", client: "A사", projectName: "프로젝트1", months: months(100) };
  const mkPlan = async (token, name, extra) => {
    const r = await api(B, auth(token, "POST", { name, baseYear: 2027, years: 1, planType: "revenue", baseRevenue: 0, revenueGrowthRate: 0, cogsRatio: 0.5, revenueItems: [revItem], ...(extra || {}) }));
    assert.equal(r.status, 200, name);
    return (await r.json()).plan;
  };

  const plan = await mkPlan(tok.memA, "영업1팀 매출 2027");
  const actuals = (token, id, body) => api(`${B}/${id}/revenue-actuals`, auth(token, "PUT", body));
  const monitor = async (token, id, qs) => {
    const r = await api(`${B}/${id}/revenue-monitor${qs || ""}`, auth(token, "GET"));
    return { status: r.status, body: await r.json() };
  };

  await t.test("실적 입력: 입력 항목 없음/일치 항목 없음/형식 불량은 400, 없는 계획은 404", async () => {
    assert.equal((await actuals(tok.memA, plan.id, { items: [] })).status, 400);
    assert.equal((await actuals(tok.memA, plan.id, {})).status, 400);
    assert.equal((await actuals(tok.memA, plan.id, { items: [{ id: "nope", actualMonths: months(1) }] })).status, 400);
    assert.equal((await actuals(tok.memA, plan.id, { items: [{ id: "rev1", actualMonths: [1, 2, 3] }] })).status, 400, "12개월이 아닌 배열은 무시되어 일치 항목 없음");
    assert.equal((await actuals(tok.memA, "plan_none", { items: [{ id: "rev1", actualMonths: months(1) }] })).status, 404);
  });

  await t.test("실적 입력 권한: 다른 부서 팀원·다른 부서 사업부장은 403, 무토큰은 401", async () => {
    const body = { items: [{ id: "rev1", actualMonths: months(1) }] };
    assert.equal((await actuals(tok.memB, plan.id, body)).status, 403);
    assert.equal((await actuals(tok.dirB, plan.id, body)).status, 403);
    assert.equal((await actuals(null, plan.id, body)).status, 401);
  });

  await t.test("같은 팀 팀원이 실적을 입력하면 저장되고 숫자가 아닌 값은 0으로 처리된다", async () => {
    const a = months(120);
    a[11] = "abc";
    const r = await actuals(tok.memA, plan.id, { items: [{ id: "rev1", actualMonths: a }] });
    assert.equal(r.status, 200);
    const b = await r.json();
    assert.equal(b.updated, 1);
    const saved = b.plan.assumptions.revenueItems.find((i) => i.id === "rev1");
    assert.equal(saved.actualMonths[0], 120);
    assert.equal(saved.actualMonths[11], 0);
  });

  await t.test("잠금(사업부장 승인) 이후에도 실적은 입력되지만 계획 금액은 바뀌지 않는다", async () => {
    assert.equal((await api(`${B}/${plan.id}/approve-division`, auth(tok.dirA, "POST", {}))).status, 200);
    const r = await actuals(tok.dirA, plan.id, {
      items: [{ id: "rev1", actualMonths: months(90), months: months(9999), baseAmount: 1 }],
      name: "바꾸기", assumptions: { baseRevenue: 1 },
    });
    assert.equal(r.status, 200);
    const b = (await r.json()).plan;
    const item = b.assumptions.revenueItems.find((i) => i.id === "rev1");
    assert.deepEqual(item.months, months(100), "계획 월별 금액은 이 경로로 변경 불가");
    assert.equal(item.baseAmount, 1200);
    assert.equal(b.name, "영업1팀 매출 2027");
    assert.deepEqual(item.actualMonths, months(90));
  });

  await t.test("모니터링: 기준월까지 누계 계획·실적·Gap, month 범위는 1~12로 보정", async () => {
    const m3 = await monitor(tok.memA, plan.id, "?month=3");
    assert.equal(m3.status, 200);
    assert.equal(m3.body.monthLimit, 3);
    assert.equal(m3.body.items[0].plan, 300);
    assert.equal(m3.body.items[0].actual, 270);
    assert.equal(m3.body.items[0].gap, -30);
    assert.deepEqual(m3.body.totals, { plan: 300, actual: 270, gap: -30 });
    assert.equal((await monitor(tok.memA, plan.id, "?month=99")).body.monthLimit, 12);
    assert.equal((await monitor(tok.memA, plan.id, "?month=0")).body.monthLimit, 12);
    assert.equal((await monitor(tok.memA, plan.id)).body.totals.plan, 1200);
  });

  await t.test("모니터링 권한: 다른 부서는 403, 없는 계획은 404, 관리자는 조회 가능", async () => {
    assert.equal((await monitor(tok.memB, plan.id)).status, 403);
    assert.equal((await monitor(tok.dirB, plan.id)).status, 403);
    assert.equal((await monitor(admin, "plan_none")).status, 404);
    assert.equal((await monitor(admin, plan.id)).status, 200);
  });

  // 개발본부 계획: 초안 상태 → 기본 롤업에서는 제외, 비용전용 계획은 항상 제외
  const planB = await mkPlan(tok.memB, "개발1팀 매출 2027", { revenueItems: [{ id: "rev2", client: "B사", months: months(50) }] });
  assert.equal((await actuals(tok.memB, planB.id, { items: [{ id: "rev2", actualMonths: months(60) }] })).status, 200);
  const costOnly = await api(B, auth(tok.memB, "POST", { name: "개발 비용", baseYear: 2027, years: 1, planType: "costOnly", team: "개발2팀" }));
  assert.equal(costOnly.status, 200);

  const rollup = async (token, qs) => {
    const r = await api(`${B}/rollup${qs || ""}`, auth(token, "GET"));
    return { status: r.status, body: await r.json() };
  };

  await t.test("롤업 권한: 팀원은 403, 사업부장은 본인 부문만, 관리자는 전체", async () => {
    assert.equal((await rollup(tok.memA)).status, 403);
    const d = await rollup(tok.dirA, "?includeDraft=true&month=3");
    assert.equal(d.status, 200);
    assert.deepEqual(d.body.revenueRollup.byDept.map((r) => r.dept), ["영업본부"]);
    const a = await rollup(admin, "?includeDraft=true&month=3");
    assert.deepEqual(a.body.revenueRollup.byDept.map((r) => r.dept), ["개발본부", "영업본부"]);
  });

  await t.test("롤업 집계: N월 누계 부문별·전사 합계, 초안은 includeDraft일 때만 포함", async () => {
    const a = (await rollup(admin, "?includeDraft=true&month=3")).body.revenueRollup;
    assert.equal(a.monthLimit, 3);
    const sales = a.byDept.find((r) => r.dept === "영업본부");
    const dev = a.byDept.find((r) => r.dept === "개발본부");
    assert.deepEqual([sales.plan, sales.actual, sales.gap], [300, 270, -30]);
    assert.deepEqual([dev.plan, dev.actual, dev.gap], [150, 180, 30]);
    assert.deepEqual(a.company, { plan: 450, actual: 450, gap: 0 });
    const noDraft = (await rollup(admin, "?month=3")).body.revenueRollup;
    assert.deepEqual(noDraft.byDept.map((r) => r.dept), ["영업본부"], "초안인 개발본부 계획은 기본 롤업에서 제외");
    const full = (await rollup(admin, "?includeDraft=true")).body.revenueRollup;
    assert.equal(full.monthLimit, 12);
    assert.equal(full.company.plan, 1800);
    const bad = (await rollup(admin, "?includeDraft=true&month=13")).body.revenueRollup;
    assert.equal(bad.monthLimit, 12, "범위 밖 month는 연간으로 보정");
  });

  await t.test("롤업 연도 필터: 다른 연도 계획은 매출 롤업에서 제외", async () => {
    const r = (await rollup(admin, "?includeDraft=true&year=2030")).body.revenueRollup;
    assert.deepEqual(r.byDept, []);
    assert.deepEqual(r.company, { plan: 0, actual: 0, gap: 0 });
  });
});
