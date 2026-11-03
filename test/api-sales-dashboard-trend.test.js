"use strict";

// 영업 대시보드 "월별 추이" — GET /api/erp/sales-dashboard?year= 의 monthlyTrend 집계 검증.
// 견적일(q.date)이 같은 연·월로 묶이는지, 수주액(수주확정+출고완료)과 매출액(출고완료)이
// 정의대로 나뉘는지, 전년 동월 비교와 증감률(전년 0이면 null)이 맞는지 손계산과 대조한다.
// 날짜는 서버가 오늘과 비교하지 않으므로 고정 연도(2030/2031)를 써도 시간이 지나 깨지지 않는다.
const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer, bootstrapAdminAndLogin } = require("./support/start-server");

const auth = (token, method, body) => ({
  method,
  headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: body !== undefined ? JSON.stringify(body) : undefined,
});

test("영업 대시보드 월별 추이 집계(수주/매출 구분, 전년 비교, 연도 파라미터, 권한)", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const api = (path, options) => fetch(server.baseUrl + path, options);
  const boot = await bootstrapAdminAndLogin(server, { loginId: "admin1", pw: "admin1-test-pw", name: "관리자1" });
  const token = boot.token;

  const item = (await (await api("/api/erp/items", auth(token, "POST", { code: "ITM-T", name: "추이품목", unit: "EA" }))).json()).item;
  const loc = (await (await api("/api/erp/locations", auth(token, "POST", { name: "본사창고" }))).json()).location;
  await api("/api/erp/stock/adjust", auth(token, "POST", { itemId: item.id, locationId: loc.id, type: "in", qty: 1000, memo: "입고", user: "admin1" }));

  // status: draft | accepted | shipped 까지 진행시켜 견적 한 건을 만든다.
  async function quote(date, qty, unitPrice, upTo) {
    const q = (await (await api("/api/erp/quotations", auth(token, "POST", {
      date, partnerName: "추이거래처", locationId: loc.id,
      items: [{ itemId: item.id, name: item.name, qty, unitPrice }], user: "admin1",
    }))).json()).quotation;
    assert.ok(q, `견적 생성 실패(${date})`);
    const steps = upTo === "draft" ? [] : upTo === "accepted" ? ["send", "accept"] : ["send", "accept", "ship"];
    for (const step of steps) {
      const r = await (await api(`/api/erp/quotations/${q.id}/${step}`, auth(token, "POST", { user: "admin1" }))).json();
      assert.equal(r.ok, true, `${step} 실패`);
    }
  }

  // 2030년(전년): 3월 출고 100,000 / 2031년(대상): 3월 출고 150,000 + 수주확정 20,000,
  // 6월 출고 40,000 + 임시 7,000(수주·매출 제외, 건수만 포함)
  await quote("2030-03-05", 10, 10000, "shipped");   // 100,000
  await quote("2031-03-02", 15, 10000, "shipped");   // 150,000
  await quote("2031-03-20", 2, 10000, "accepted");   // 수주 20,000 (매출 아님)
  await quote("2031-06-11", 4, 10000, "shipped");    // 40,000
  await quote("2031-06-25", 1, 7000, "draft");       // 임시

  const get = async (qs = "") => {
    const r = await api(`/api/erp/sales-dashboard${qs}`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(r.status, 200);
    return r.json();
  };

  await t.test("2031년: 월별 수주/매출/건수와 전년 동월 비교가 손계산과 일치", async () => {
    const { monthlyTrend: tr } = await get("?year=2031");
    assert.equal(tr.year, 2031);
    assert.equal(tr.months.length, 12);
    const mar = tr.months[2], jun = tr.months[5], jan = tr.months[0];
    assert.deepEqual([mar.count, mar.order, mar.revenue, mar.prevRevenue, mar.revenueGrowthPct], [2, 170000, 150000, 100000, 50]);
    // 6월: 임시 견적은 건수에만 잡히고 수주·매출은 출고 건만 → 40,000, 전년 동월 0이면 증감률 null
    assert.deepEqual([jun.count, jun.order, jun.revenue, jun.prevRevenue, jun.revenueGrowthPct], [2, 40000, 40000, 0, null]);
    assert.deepEqual([jan.count, jan.order, jan.revenue], [0, 0, 0]);
    assert.ok(tr.years.includes(2030) && tr.years.includes(2031));
  });

  await t.test("데이터가 없는 연도를 골라도 연도 선택지에 그 연도가 남는다", async () => {
    const { monthlyTrend: tr } = await get("?year=2040");
    assert.equal(tr.year, 2040);
    assert.ok(tr.years.includes(2040), "선택한 연도가 목록에 없으면 select가 다른 연도를 보여준다");
  });

  await t.test("연도를 2030으로 바꾸면 그 해가 기준이 되고 전년(2029)은 0", async () => {
    const { monthlyTrend: tr } = await get("?year=2030");
    assert.equal(tr.year, 2030);
    assert.equal(tr.months[2].revenue, 100000);
    assert.equal(tr.months[2].prevRevenue, 0);
    assert.equal(tr.months[2].revenueGrowthPct, null);
  });

  await t.test("담당자 필터(?rep=)와 수주 건수(orderCount)", async () => {
    // 견적 작성자는 서버가 로그인 계정으로 정한다(body.user 무시) → 두 번째 관리자 계정으로 다른 담당자 견적을 만든다.
    const init = await (await api("/data", { headers: { Authorization: `Bearer ${token}` } })).json();
    const sv = await (await api("/save", auth(token, "POST", { _version: init.version, data: { ...init.data, employees: [...init.data.employees,
      { id: "a2", loginId: "admin2", pw: "admin2-test-pw", name: "관리자2", role: "admin", active: true, menuPerms: {} }] } }))).json();
    assert.equal(sv.ok, true);
    const login2 = await (await api("/login", auth(null, "POST", { loginId: "admin2", pw: "admin2-test-pw" }))).json();
    assert.ok(login2.token, "두 번째 관리자 로그인 실패");
    const t2 = login2.token;
    const q = (await (await api("/api/erp/quotations", auth(t2, "POST", {
      date: "2031-03-15", partnerName: "추이거래처", locationId: loc.id,
      items: [{ itemId: item.id, name: item.name, qty: 1, unitPrice: 5000 }],
    }))).json()).quotation;
    assert.ok(q);
    for (const step of ["send", "accept"]) await api(`/api/erp/quotations/${q.id}/${step}`, auth(t2, "POST", {}));
    const all = (await get("?year=2031")).monthlyTrend;
    // 3월: admin1의 출고1+수주1, admin2의 수주1 → 수주 건수(수주확정+출고완료) 3
    assert.equal(all.months[2].orderCount, 3);
    assert.equal(all.reps.length, 2, "담당자 목록은 필터와 무관하게 전체");
    const rep2 = q.createdBy || all.reps.find(r => !String(r).includes("admin1"));
    const only = (await get(`?year=2031&rep=${encodeURIComponent(rep2)}`)).monthlyTrend;
    assert.equal(only.rep, rep2);
    assert.equal(only.months[2].orderCount, 1);
    assert.equal(only.months[2].order, 5000);
    assert.deepEqual(only.reps, all.reps, "필터를 걸어도 담당자 목록은 그대로");
    // 존재하지 않는 담당자 → 전부 0, 목록에는 선택값이 남는다
    const none = (await get(`?year=2031&rep=${encodeURIComponent("없는사람")}`)).monthlyTrend;
    assert.equal(none.months.reduce((s, m) => s + m.count, 0), 0);
    assert.ok(none.reps.includes("없는사람"));
  });

  await t.test("year 파라미터가 비정상이면 올해로 안전하게 대체되고 기존 집계 필드는 그대로", async () => {
    for (const qs of ["?year=abc", "?year=1", "?year=99999", "?year="]) {
      const body = await get(qs);
      assert.equal(body.monthlyTrend.year, new Date().getFullYear(), qs);
      assert.ok(Array.isArray(body.pipeline) && Array.isArray(body.partnerRanking) && Array.isArray(body.repRanking), qs);
    }
  });

  await t.test("인증 없음 401 / 일반 직원 403 (기존 게이팅 유지)", async () => {
    assert.equal((await api("/api/erp/sales-dashboard")).status, 401);
    const init = await (await api("/data", { headers: { Authorization: `Bearer ${token}` } })).json();
    await api("/save", auth(token, "POST", { _version: init.version, data: { ...init.data, employees: [...init.data.employees,
      { id: "m1", loginId: "m1", pw: "m1-test-pw", name: "직원", role: "member", active: true, menuPerms: {} }] } }));
    const login = await (await api("/login", auth(null, "POST", { loginId: "m1", pw: "m1-test-pw" }))).json();
    const r = await api("/api/erp/sales-dashboard?year=2031", { headers: { Authorization: `Bearer ${login.token}` } });
    assert.equal(r.status, 403);
  });
});
