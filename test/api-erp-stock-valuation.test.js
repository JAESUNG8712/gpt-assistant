"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { computeStockValuation } = require("../lib/stock-valuation");
const { startServer, bootstrapAdminAndLogin } = require("./support/start-server");

const T = (d, h = 9) => `${d}T0${h}:00:00.000Z`;

test("재고평가 순수 계산: 이동평균과 FIFO 손계산 대조", () => {
  const items = [{ id: "A", code: "A", name: "품목A", unit: "EA", unitCost: 50 }];
  const ledger = [
    { itemId: "A", locationId: "L1", type: "in", qty: 10, refType: "po", unitCost: 100, createdAt: T("2032-01-01") },
    { itemId: "A", locationId: "L1", type: "in", qty: 10, refType: "po", unitCost: 200, createdAt: T("2032-01-02") },
    { itemId: "A", locationId: "L1", type: "out", qty: 15, refType: "quotation", createdAt: T("2032-01-03") },
  ];
  const r = computeStockValuation(ledger, items);
  const a = r.items[0];
  assert.equal(a.qty, 5);
  // 이동평균: 평균 150, 출고 15 → 남은 5 × 150 = 750
  assert.equal(a.avg.value, 750);
  assert.equal(a.avg.unitCost, 150);
  // FIFO: 100×10 소진 후 200 층에서 5 → 남은 5 × 200 = 1000
  assert.equal(a.fifo.value, 1000);
  assert.equal(a.fifo.unitCost, 200);
  assert.equal(r.totals.avg, 750);
  assert.equal(r.totals.fifo, 1000);
  assert.equal(a.estimatedRows, 0);
});

test("재고평가: 단가 없는 입고는 품목 단가로 추정, 반품 입고는 평균 단가, 이동은 제외, 기준일 필터", () => {
  const items = [{ id: "A", code: "A", name: "A", unitCost: 40 }];
  const ledger = [
    { itemId: "A", locationId: "L1", type: "in", qty: 10, refType: "manual", createdAt: T("2032-02-01") },          // 40 추정
    { itemId: "A", locationId: "L1", type: "out", qty: 4, refType: "transfer", createdAt: T("2032-02-02") },        // 이동 제외
    { itemId: "A", locationId: "L2", type: "in", qty: 4, refType: "transfer", createdAt: T("2032-02-02") },
    { itemId: "A", locationId: "L1", type: "out", qty: 5, refType: "quotation", createdAt: T("2032-02-03") },       // 평균 40 × 5
    { itemId: "A", locationId: "L1", type: "in", qty: 2, refType: "quotation_return", createdAt: T("2032-02-04") }, // 평균 40 추정
    { itemId: "A", locationId: "L1", type: "in", qty: 10, refType: "manual", unitCost: 100, createdAt: T("2032-03-01") },
  ];
  const feb = computeStockValuation(ledger, items, { asOf: "2032-02-28" }).items[0];
  assert.equal(feb.qty, 7);
  assert.equal(feb.avg.value, 280);       // 7 × 40
  assert.equal(feb.fifo.value, 280);
  assert.equal(feb.estimatedRows, 2);
  const mar = computeStockValuation(ledger, items).items[0];
  assert.equal(mar.qty, 17);
  assert.equal(mar.avg.value, 280 + 1000);
  assert.equal(mar.fifo.value, 280 + 1000);
});

test("재고평가: 마이너스 재고는 금액 0으로 두고 이후 입고가 먼저 메운다", () => {
  const items = [{ id: "A", unitCost: 10 }];
  const ledger = [
    { itemId: "A", type: "out", qty: 3, refType: "manual", createdAt: T("2032-04-01") },
    { itemId: "A", type: "in", qty: 5, refType: "manual", unitCost: 20, createdAt: T("2032-04-02") },
  ];
  const a = computeStockValuation(ledger, items).items[0];
  assert.equal(a.qty, 2);
  assert.equal(a.avg.value, 40);
});

async function apiScenario(baseUrl, token) {
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const call = async (path, body, expected = 200) => {
    const res = await fetch(baseUrl + path, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? headers : { ...headers, "Idempotency-Key": randomUUID() },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json();
    assert.equal(res.status, expected, `${path} → ${res.status} ${JSON.stringify(json)}`);
    return json;
  };
  const item = (await call("/api/erp/items", { code: "V-1", name: "평가품목", unit: "EA", unitCost: 500 })).item.id;
  const loc = (await call("/api/erp/locations", { name: "평가창고" })).location.id;

  await call("/api/erp/stock/adjust", { itemId: item, locationId: loc, type: "in", qty: 10, unitCost: -1 }, 400);
  await call("/api/erp/stock/adjust", { itemId: item, locationId: loc, type: "in", qty: 10, unitCost: "abc" }, 400);
  await call("/api/erp/stock/adjust", { itemId: item, locationId: loc, type: "in", qty: 10, unitCost: 100 });
  const po = (await call("/api/erp/purchase-orders", { date: "2032-06-01", partnerName: "공급사", locationId: loc, items: [{ itemId: item, qty: 10, unitPrice: 200 }] })).purchaseOrder;
  await call(`/api/erp/purchase-orders/${po.id}/confirm`, {});
  await call(`/api/erp/purchase-orders/${po.id}/receive`, {});
  await call("/api/erp/stock/adjust", { itemId: item, locationId: loc, type: "out", qty: 15 });

  const v = await call("/api/erp/stock/valuation");
  const row = v.items.find(r => r.itemId === item);
  assert.equal(row.qty, 5);
  assert.equal(row.fifo.value, 1000);   // 100×10 소진 후 200 층 5개
  assert.equal(row.avg.value, 750);     // 평균 150 × 5
  assert.equal(row.estimatedRows, 0);

  await call("/api/erp/stock/valuation?asOf=2032-13-40", undefined, 400);
  const future = await call("/api/erp/stock/valuation?asOf=2000-01-01");
  assert.equal(future.items.length, 0);
}

test("재고평가 API — 발주 단가·수동 취득단가 기록과 검증 (JSON)", async t => {
  const server = await startServer();
  t.after(() => server.stop());
  const { token } = await bootstrapAdminAndLogin(server, { loginId: "valadmin", pw: "ValuationPassw0rd!" });
  await apiScenario(server.baseUrl, token);
});

const ADMIN_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!ADMIN_DATABASE_URL) {
  test("재고평가 API — PostgreSQL (skipped: no test DB)", { skip: true }, () => {});
} else {
  const { Client } = require("pg");
  test("재고평가 API — PostgreSQL", async t => {
    const dbName = `hrtest_erp_val_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
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
    const response = await fetch(server.baseUrl + "/api/companies/register", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ companyName: "재고평가 회사", adminName: "관리자", loginId: "val_admin", password: "AdminPassw0rd1" }),
    });
    const reg = await response.json();
    if (!reg.ok) throw new Error(JSON.stringify(reg));
    await apiScenario(server.baseUrl, reg.token);
  });
}

test("재고평가 API는 권한 없는 사용자에게 열리지 않는다", async t => {
  const server = await startServer();
  t.after(() => server.stop());
  const res = await fetch(server.baseUrl + "/api/erp/stock/valuation");
  assert.equal(res.status, 401);
});
