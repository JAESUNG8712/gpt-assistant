"use strict";

// "구조적 한계 #2"(회계·ERP 등 대량 조회 API가 menuPerms로 좁혀지지 않던 문제)의 ERP 모듈
// 증분 — 견적서/발주서/구매요청/재고/영업목표 원본 GET 라우트를 requirePage()로 게이팅하기
// 전에, 유일한 cross-page 소비처였던 영업 실적 대시보드(sales-dashboard)가 원본 견적서
// 레코드 대신 서버가 미리 집계한 결과(GET .../erp/sales-dashboard)만 받도록 먼저 바꾼 것을
// 검증한다. items/locations는 이미 requireAuth만으로 전 역할 공개돼 있어(구매요청 화면이
// 참조) 이번 증분에서 변경하지 않았다.
const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer, bootstrapAdminAndLogin } = require("./support/start-server");

async function login(api, loginId, pw) {
  const response = await api("/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ loginId, pw }),
  });
  const body = await response.json();
  assert.equal(body.ok, true, `${loginId} 로그인 실패`);
  return body.token;
}

function auth(token, method, body) {
  return {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  };
}

test("ERP 영업 실적 대시보드 서버집계 + quotations·purchase-orders·purchase-requests·stock·sales-targets 게이팅", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const api = (path, options) => fetch(server.baseUrl + path, options);

  const boot = await bootstrapAdminAndLogin(server, { loginId: "admin1", pw: "admin1-test-pw", name: "관리자1" });
  const adminToken = boot.token;

  // admin1은 개인적으로 "sales-quotations"/"sales-dashboard"/"inv-stock"/"inv-purchase-requests"만
  // 꺼둔다(다른 ERP 화면은 열려있음) — role 체크만으로는 menuPerms 효과를 구분할 수 없어
  // 대조군 admin2도 함께 시딩.
  const initial = await (await api("/data", { headers: { Authorization: `Bearer ${adminToken}` } })).json();
  const employees = [
    ...initial.data.employees.map(e => e.loginId === "admin1"
      ? { ...e, menuPerms: { "sales-quotations": false, "sales-dashboard": false, "inv-stock": false, "inv-purchase-requests": false, "sales-purchase-orders": false } }
      : e),
    { id: "admin2", loginId: "admin2", pw: "admin2-test-pw", name: "관리자2", role: "admin", active: true, menuPerms: {} },
    { id: "member1", loginId: "member1", pw: "member1-test-pw", name: "일반직원", role: "member", active: true, dept: "영업본부", team: "영업1팀", menuPerms: {} },
  ];
  const seed = await api("/save", auth(adminToken, "POST", { _version: initial.version, data: { ...initial.data, employees } }));
  assert.equal(seed.status, 200);

  const restrictedToken = adminToken; // admin1
  const admin2Token = await login(api, "admin2", "admin2-test-pw");
  const memberToken = await login(api, "member1", "member1-test-pw");

  // ── 품목/위치 마스터(items/locations는 전 역할 공개, 이번 증분 범위 밖) ──
  const item = await (await api("/api/erp/items", auth(admin2Token, "POST", {
    code: "ITM-1", name: "테스트품목", unit: "EA",
  }))).json();
  assert.equal(item.ok, true);
  const loc = await (await api("/api/erp/locations", auth(admin2Token, "POST", { name: "본사창고" }))).json();
  assert.equal(loc.ok, true);

  // ── 입고(재고 확보) → 견적서 draft→send→accept→ship ──
  const adj = await (await api("/api/erp/stock/adjust", auth(admin2Token, "POST", {
    itemId: item.item.id, locationId: loc.location.id, type: "in", qty: 100, memo: "초기입고", user: "admin2",
  }))).json();
  assert.equal(adj.ok, true);

  const quote = await (await api("/api/erp/quotations", auth(admin2Token, "POST", {
    date: "2031-06-10", partnerName: "테스트거래처", locationId: loc.location.id,
    items: [{ itemId: item.item.id, name: item.item.name, qty: 10, unitPrice: 5000 }],
    user: "admin2",
  }))).json();
  assert.equal(quote.ok, true);
  const sent = await (await api(`/api/erp/quotations/${quote.quotation.id}/send`, auth(admin2Token, "POST", { user: "admin2" }))).json();
  assert.equal(sent.ok, true);
  const accepted = await (await api(`/api/erp/quotations/${quote.quotation.id}/accept`, auth(admin2Token, "POST", { user: "admin2" }))).json();
  assert.equal(accepted.ok, true);
  const shipped = await (await api(`/api/erp/quotations/${quote.quotation.id}/ship`, auth(admin2Token, "POST", { user: "admin2" }))).json();
  assert.equal(shipped.ok, true);

  // 두 번째 견적서는 draft 상태로 남겨 pipeline 집계 대상으로 삼는다.
  const quote2 = await (await api("/api/erp/quotations", auth(admin2Token, "POST", {
    date: "2031-06-15", partnerName: "다른거래처",
    items: [{ itemId: item.item.id, name: item.item.name, qty: 5, unitPrice: 3000 }],
    user: "admin2",
  }))).json();
  assert.equal(quote2.ok, true);

  // ── 영업 목표 등록 ──
  const target = await (await api("/api/erp/sales-targets", auth(admin2Token, "POST", {
    year: 2031, targetAmount: 40000, memo: "6월 목표", user: "admin2",
  }))).json();
  assert.equal(target.ok, true);

  await t.test("GET .../erp/sales-dashboard — 서버가 집계한 목표/거래처/파이프라인/담당자별 실적을 반환(원본 견적서 레코드 아님)", async () => {
    const r = await api("/api/erp/sales-dashboard", { headers: { Authorization: `Bearer ${admin2Token}` } });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);
    assert.equal("quotations" in body, false);

    const rows2031 = body.targetsByYear["2031"];
    assert.ok(rows2031);
    assert.equal(rows2031[0].targetAmount, 40000);
    // shipped(50,000원)만 accepted∥shipped에 잡힌다 — draft 상태인 quote2는 제외.
    assert.equal(rows2031[0].actual, 50000);
    assert.equal(rows2031[0].rate, 125);

    const partnerRow = body.partnerRanking.find(p => p.name === "테스트거래처");
    assert.ok(partnerRow);
    assert.equal(partnerRow.amount, 50000);
    assert.equal(body.partnerRanking.some(p => p.name === "다른거래처"), false, "draft 상태는 거래처별 매출(출고완료 기준)에서 제외돼야 함");

    const draftStage = body.pipeline.find(p => p.status === "draft");
    assert.equal(draftStage.count, 1);
    assert.equal(draftStage.amount, 15000);
    const shippedStage = body.pipeline.find(p => p.status === "shipped");
    assert.equal(shippedStage.count, 1);
    assert.equal(shippedStage.amount, 50000);

    const rep = body.repRanking.find(r => r.name === "admin2");
    assert.ok(rep);
    assert.equal(rep.count, 2);
    assert.equal(rep.order, 50000); // accepted∥shipped
    assert.equal(rep.revenue, 50000); // shipped만
  });

  await t.test("GET .../erp/sales-dashboard — 개인적으로 꺼둔 admin1은 403", async () => {
    const r = await api("/api/erp/sales-dashboard", { headers: { Authorization: `Bearer ${restrictedToken}` } });
    assert.equal(r.status, 403);
  });

  const gatedRoutes = [
    ["/api/erp/quotations", "sales-quotations"],
    ["/api/erp/purchase-orders", "sales-purchase-orders"],
    ["/api/erp/stock", "inv-stock"],
    ["/api/erp/stock/ledger", "inv-stock"],
    ["/api/erp/sales-targets", "sales-dashboard"],
  ];
  for (const [path] of gatedRoutes) {
    await t.test(`GET ${path} — 대응 페이지를 개인적으로 꺼둔 admin1은 403, 대조군 admin2는 200, member는 role 자체에서 403`, async () => {
      const r1 = await api(path, { headers: { Authorization: `Bearer ${restrictedToken}` } });
      assert.equal(r1.status, 403, `${path} restricted`);
      const r2 = await api(path, { headers: { Authorization: `Bearer ${admin2Token}` } });
      assert.equal(r2.status, 200, `${path} admin2`);
      const r3 = await api(path, { headers: { Authorization: `Bearer ${memberToken}` } });
      assert.equal(r3.status, 403, `${path} member`);
    });
  }

  await t.test("GET /api/erp/purchase-requests — inv-purchase-requests를 꺼둔 admin1은 403, member(전 역할 공개)는 자기 요청만 담긴 채 200", async () => {
    const r1 = await api("/api/erp/purchase-requests", { headers: { Authorization: `Bearer ${restrictedToken}` } });
    assert.equal(r1.status, 403);
    const r2 = await api("/api/erp/purchase-requests", { headers: { Authorization: `Bearer ${memberToken}` } });
    assert.equal(r2.status, 200);
    const body = await r2.json();
    assert.equal(body.ok, true);
  });

  await t.test("GET .../erp/items, .../erp/locations — menuPerms와 무관하게 인증만 있으면 계속 조회 가능(전 역할 공개, 이번 증분 미변경)", async () => {
    const r1 = await api("/api/erp/items", { headers: { Authorization: `Bearer ${restrictedToken}` } });
    assert.equal(r1.status, 200);
    const r2 = await api("/api/erp/locations", { headers: { Authorization: `Bearer ${memberToken}` } });
    assert.equal(r2.status, 200);
  });
});
