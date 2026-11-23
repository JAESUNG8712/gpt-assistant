"use strict";
// 창고(위치)별 재고평가와 재고평가 회계 반영(재고자산 조정 전표) — 순수 계산 + API(JSON/PostgreSQL).
const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { computeLocationValuation, computeStockValuation } = require("../lib/stock-valuation");
const { startServer, bootstrapAdminAndLogin } = require("./support/start-server");

const T = (d, h = 9) => `${d}T0${h}:00:00.000Z`;

test("창고별 평가: 이동은 출발 창고의 단가(이동평균·FIFO 층)를 그대로 도착 창고로 옮긴다", () => {
  const items = [{ id: "A", code: "A", name: "품목A", unit: "EA", unitCost: 50 }];
  const ledger = [
    { itemId: "A", locationId: "L1", type: "in", qty: 10, refType: "po", unitCost: 100, createdAt: T("2032-01-01") },
    { itemId: "A", locationId: "L1", type: "in", qty: 10, refType: "po", unitCost: 200, createdAt: T("2032-01-02") },
    { itemId: "A", locationId: "L1", type: "out", qty: 12, refType: "transfer", refId: "t1", createdAt: T("2032-01-03") },
    { itemId: "A", locationId: "L2", type: "in", qty: 12, refType: "transfer", refId: "t1", createdAt: T("2032-01-03") },
  ];
  const r = computeLocationValuation(ledger, items, { locationNames: { L1: "본사", L2: "지점" } });
  const l1 = r.locations.find(l => l.locationId === "L1");
  const l2 = r.locations.find(l => l.locationId === "L2");
  assert.equal(l1.name, "본사");
  // L1: 이동평균 평균 150 → 8 × 150, FIFO 100 층 소진 후 200 층 8개
  assert.equal(l1.items[0].qty, 8);
  assert.equal(l1.items[0].avg.value, 1200);
  assert.equal(l1.items[0].fifo.value, 1600);
  // L2: 이동평균 단가 150 그대로 12 × 150, FIFO 층 (100×10 + 200×2)
  assert.equal(l2.items[0].qty, 12);
  assert.equal(l2.items[0].avg.value, 1800);
  assert.equal(l2.items[0].fifo.value, 1400);
  // 위치별 합계는 전 창고 합산 평가와 같다(이 시나리오는 이동 후에도 단가 흐름이 같다)
  const whole = computeStockValuation(ledger, items).totals;
  assert.equal(r.totals.avg, whole.avg);
  assert.equal(r.totals.fifo, whole.fifo);
});

test("창고별 평가: 짝 없는 이동 입고는 품목 단가로 추정, 기준일 필터, 수량 0 행 생략", () => {
  const items = [{ id: "A", unitCost: 70 }];
  const ledger = [
    { itemId: "A", locationId: "L2", type: "in", qty: 3, refType: "transfer", refId: "lost", createdAt: T("2032-02-01") },
    { itemId: "A", locationId: "L1", type: "in", qty: 5, refType: "manual", unitCost: 10, createdAt: T("2032-02-02") },
    { itemId: "A", locationId: "L1", type: "out", qty: 5, refType: "manual", createdAt: T("2032-02-03") },
  ];
  const r = computeLocationValuation(ledger, items);
  assert.equal(r.locations.length, 1); // L1은 재고 0이라 생략
  assert.equal(r.locations[0].locationId, "L2");
  assert.equal(r.locations[0].items[0].avg.value, 210);
  assert.equal(r.locations[0].items[0].estimatedRows, 1);
  const early = computeLocationValuation(ledger, items, { asOf: "2032-02-01" });
  assert.equal(early.locations.length, 1);
  assert.equal(computeLocationValuation(ledger, items, { asOf: "2031-01-01" }).locations.length, 0);
});

function makeCaller(baseUrl, token) {
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  return async (path, body, expected = 200) => {
    const res = await fetch(baseUrl + path, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? headers : { ...headers, "Idempotency-Key": randomUUID() },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json();
    assert.equal(res.status, expected, `${path} → ${res.status} ${JSON.stringify(json)}`);
    return json;
  };
}
const dayStr = offset => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

async function apiScenario(baseUrl, token, tag) {
  const call = makeCaller(baseUrl, token);
  const item = (await call("/api/erp/items", { code: `${tag}-1`, name: "창고평가품목", unit: "EA", unitCost: 500 })).item.id;
  const l1 = (await call("/api/erp/locations", { name: `${tag}-본사` })).location.id;
  const l2 = (await call("/api/erp/locations", { name: `${tag}-지점` })).location.id;
  const invAcc = (await call("/api/accounting/accounts", { code: `${tag}-INV`, name: "재고자산", type: "asset", user: "t" })).account.id;
  const adjAcc = (await call("/api/accounting/accounts", { code: `${tag}-ADJ`, name: "재고자산평가손익", type: "expense", user: "t" })).account.id;

  await call("/api/erp/stock/adjust", { itemId: item, locationId: l1, type: "in", qty: 10, unitCost: 100 });
  await call("/api/erp/stock/adjust", { itemId: item, locationId: l1, type: "in", qty: 10, unitCost: 200 });
  await call("/api/erp/stock/transfer", { itemId: item, fromLocationId: l1, toLocationId: l2, qty: 12 });

  const v = await call("/api/erp/stock/valuation?by=location");
  assert.equal(v.totals.avg, 3000);
  const byLoc = Object.fromEntries(v.byLocation.locations.map(l => [l.locationId, l]));
  assert.equal(byLoc[l1].name, `${tag}-본사`);
  assert.equal(byLoc[l1].totals.avg, 1200);
  assert.equal(byLoc[l1].totals.fifo, 1600);
  assert.equal(byLoc[l2].totals.avg, 1800);
  assert.equal(byLoc[l2].totals.fifo, 1400);
  assert.equal(v.byLocation.totals.avg, 3000);
  // by=location 없이는 기존 응답과 같다(byLocation 없음)
  assert.equal((await call("/api/erp/stock/valuation")).byLocation, undefined);

  // ── 회계 반영(재고자산 조정 전표) ───────────────────────────────
  const today = dayStr(0);
  const post = (extra, expected = 200) => call("/api/erp/stock/valuation/post-voucher",
    { asOf: today, method: "avg", inventoryAccountId: invAcc, adjustmentAccountId: adjAcc, ...extra }, expected);
  await post({ asOf: "2032-13-40" }, 400);
  await post({ method: "lifo" }, 400);
  await post({ adjustmentAccountId: invAcc }, 400);
  await post({ inventoryAccountId: "" }, 400);

  const first = await post({});
  assert.equal(first.voucher.status, "posted");
  assert.equal(first.voucher.source, "stock_valuation");
  assert.equal(first.valuation.totalValue, 3000);
  assert.equal(first.valuation.previousValue, 0);
  assert.equal(first.valuation.delta, 3000);
  const dr = first.voucher.lines.find(l => l.debit > 0), cr = first.voucher.lines.find(l => l.credit > 0);
  assert.equal(dr.accountId, invAcc); assert.equal(dr.debit, 3000);
  assert.equal(cr.accountId, adjAcc); assert.equal(cr.credit, 3000);

  const dup = await post({}, 409);
  assert.equal(dup.code, "STOCK_VALUATION_ALREADY_POSTED");

  // 재고 +5 @300 → 이동평균 총액 3000 + 1500 = 4500, 내일 기준으로 차이만 반영
  await call("/api/erp/stock/adjust", { itemId: item, locationId: l1, type: "in", qty: 5, unitCost: 300 });
  const tomorrow = dayStr(1);
  const second = await post({ asOf: tomorrow });
  assert.equal(second.valuation.previousValue, 3000);
  assert.equal(second.valuation.delta, 1500);
  // 더 늦은 기준일의 반영이 있으면 이전 기준일은 거절
  const later = await post({ asOf: dayStr(0) }, 409); // 같은 기준일이므로 ALREADY
  assert.equal(later.code, "STOCK_VALUATION_ALREADY_POSTED");
  const earlier = await post({ asOf: dayStr(-1) }, 409);
  assert.equal(earlier.code, "STOCK_VALUATION_LATER_EXISTS");

  // 방식(fifo)은 독립적으로 처음부터 계산한다
  const fifo = await post({ method: "fifo", asOf: tomorrow });
  assert.equal(fifo.valuation.previousValue, 0);
  assert.equal(fifo.valuation.delta, fifo.valuation.totalValue);

  // 차이가 없으면 거절하고, 취소된 전표는 없던 것으로 본다
  await call(`/api/accounting/vouchers/${second.voucher.id}/void`, { reason: "테스트 취소", user: "t" });
  const reposted = await post({ asOf: tomorrow });
  assert.equal(reposted.valuation.previousValue, 3000);
  assert.equal(reposted.valuation.delta, 1500);
  const none = await post({ asOf: dayStr(2) }, 400);
  assert.equal(none.code, "STOCK_VALUATION_NO_DELTA");
}

test("창고별 재고평가·평가 전표 API (JSON)", async t => {
  const server = await startServer();
  t.after(() => server.stop());
  const { token } = await bootstrapAdminAndLogin(server, { loginId: "locval", pw: "LocValPassw0rd!" });
  await apiScenario(server.baseUrl, token, "LJ");
});

test("창고별 재고평가 API는 인증 없이 열리지 않는다", async t => {
  const server = await startServer();
  t.after(() => server.stop());
  assert.equal((await fetch(server.baseUrl + "/api/erp/stock/valuation?by=location")).status, 401);
  const r = await fetch(server.baseUrl + "/api/erp/stock/valuation/post-voucher", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(r.status, 401);
});

const ADMIN_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!ADMIN_DATABASE_URL) {
  test("창고별 재고평가·평가 전표 API — PostgreSQL (skipped: no test DB)", { skip: true }, () => {});
} else {
  const { Client } = require("pg");
  test("창고별 재고평가·평가 전표 API — PostgreSQL", async t => {
    const dbName = `hrtest_erp_locval_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
    const base = ADMIN_DATABASE_URL.replace(/\/[^/]*(\?.*)?$/, "");
    const admin = new Client({ connectionString: ADMIN_DATABASE_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    let server;
    t.after(async () => {
      try {
        if (server) await server.stop();
        await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()", [dbName]);
        await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
      } finally { await admin.end(); }
    });
    server = await startServer({ env: { DATABASE_URL: `${base}/${dbName}` } });
    const reg = await (await fetch(server.baseUrl + "/api/companies/register", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ companyName: "창고평가 회사", adminName: "관리자", loginId: "lv_admin", password: "AdminPassw0rd1" }),
    })).json();
    if (!reg.ok) throw new Error(JSON.stringify(reg));
    await apiScenario(server.baseUrl, reg.token, "LP");
    // 동시에 같은 기준일을 두 번 요청해도 한 번만 반영된다
    const call = makeCaller(server.baseUrl, reg.token);
    const a = (await call("/api/accounting/accounts", { code: "LP-A2", name: "재고2", type: "asset", user: "t" })).account.id;
    const b = (await call("/api/accounting/accounts", { code: "LP-B2", name: "손익2", type: "expense", user: "t" })).account.id;
    const it2 = (await call("/api/erp/items", { code: "LP-C2", name: "동시성품목", unit: "EA", unitCost: 5 })).item.id;
    const lc2 = (await call("/api/erp/locations", { name: "LP-동시창고" })).location.id;
    await call("/api/erp/stock/adjust", { itemId: it2, locationId: lc2, type: "in", qty: 7, unitCost: 1000 });
    const rs = await Promise.all([0, 1, 2].map(() => fetch(server.baseUrl + "/api/erp/stock/valuation/post-voucher", {
      method: "POST", headers: { Authorization: `Bearer ${reg.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ asOf: dayStr(10), method: "fifo", inventoryAccountId: a, adjustmentAccountId: b }),
    })));
    const statuses = (await Promise.all(rs.map(r => r.status))).sort();
    // 재고가 늘어 차이가 있으므로 정확히 한 건만 200, 나머지는 같은 기준일 중복(409)
    assert.equal(statuses.filter(s => s === 200).length, 1, `statuses=${statuses}`);
  });
}
