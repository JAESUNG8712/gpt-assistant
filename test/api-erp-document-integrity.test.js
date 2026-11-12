"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { startServer, bootstrapAdminAndLogin } = require("./support/start-server");

test("ERP document transitions preserve linked records and reject stale operations", async t => {
  const server = await startServer();
  t.after(() => server.stop());
  const { token } = await bootstrapAdminAndLogin(server, { loginId: "erpadmin", pw: "ErpTestPassword123!" });
  const api = async (path, method = "GET", body) => {
    const response = await fetch(server.baseUrl + "/api/erp/" + path, {
      method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, ...await response.json() };
  };
  const item = (await api("items", "POST", { code: "SAFE-ITEM", name: "Test item", unit: "EA" })).item;
  const location = (await api("locations", "POST", { name: "Test warehouse" })).location;
  const input = { date: "2031-05-01", items: [{ itemId: item.id, qty: 2, unitPrice: 100 }] };
  async function request() {
    const r = await api("purchase-requests", "POST", input);
    assert.equal(r.ok, true, JSON.stringify(r));
    return r.purchaseRequest;
  }

  await t.test("competing approval/rejection has exactly one winner and cannot delete the result", async () => {
    const pr = await request();
    const results = await Promise.all([
      api(`purchase-requests/${pr.id}/approve`, "POST", {}),
      api(`purchase-requests/${pr.id}/reject`, "POST", { reason: "Not needed" }),
    ]);
    assert.deepEqual(results.map(r => r.status).sort(), [200, 400]);
    const winner = results.find(r => r.ok).purchaseRequest;
    assert.equal((await api(`purchase-requests/${pr.id}`, "DELETE")).status, 400);
    const saved = (await api("purchase-requests")).purchaseRequests.find(r => r.id === pr.id);
    assert.equal(saved.status, winner.status);
  });

  await t.test("converted order retains its source link; cancellation preserves the first reason", async () => {
    const pr = await request();
    assert.equal((await api(`purchase-requests/${pr.id}/approve`, "POST", {})).status, 200);
    const converted = await api(`purchase-requests/${pr.id}/convert-to-po`, "POST", {
      partnerName: "Test supplier", locationId: location.id,
    });
    assert.equal(converted.ok, true, JSON.stringify(converted));
    const po = converted.purchaseOrder;
    const denied = await api(`purchase-orders/${po.id}`, "DELETE");
    assert.equal(denied.status, 409);
    assert.equal(denied.code, "ERP_ORDER_LINKED");
    assert.equal((await api(`purchase-orders/${po.id}/cancel`, "POST", { reason: "First reason" })).status, 200);
    assert.equal((await api(`purchase-orders/${po.id}/cancel`, "POST", { reason: "Overwrite" })).status, 400);
    const saved = (await api("purchase-orders")).purchaseOrders.find(r => r.id === po.id);
    assert.equal(saved.cancelReason, "First reason");
    assert.equal(saved.sourcePurchaseRequestId, pr.id);
    assert.equal((await api("purchase-requests")).purchaseRequests.find(r => r.id === pr.id).convertedPoId, po.id);
  });

  await t.test("ordinary draft order can still be deleted", async () => {
    const created = await api("purchase-orders", "POST", { ...input, partnerName: "Test supplier", locationId: location.id });
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.equal((await api(`purchase-orders/${created.purchaseOrder.id}`, "DELETE")).status, 200);
    assert.ok(!(await api("purchase-orders")).purchaseOrders.some(r => r.id === created.purchaseOrder.id));
  });

  await t.test("failed receipt leaves both stores unchanged; retry creates one ledger entry and invoice", async () => {
    const created = await api("purchase-orders", "POST", { ...input, partnerName: "Test supplier", locationId: location.id });
    assert.equal(created.ok, true, JSON.stringify(created));
    const id = created.purchaseOrder.id;
    assert.equal((await api(`purchase-orders/${id}/confirm`, "POST", {})).status, 200);
    const file = server.dataFile.replace(/\.json$/, "-accounting.json");
    const backup = file + ".test-backup";
    fs.renameSync(file, backup);
    fs.mkdirSync(file);
    try {
      assert.equal((await api(`purchase-orders/${id}/receive`, "POST", {})).status, 500);
      assert.equal((await api("purchase-orders")).purchaseOrders.find(r => r.id === id).status, "ordered");
    } finally {
      fs.rmdirSync(file);
      fs.renameSync(backup, file);
    }
    const responses = await Promise.all([
      api(`purchase-orders/${id}/receive`, "POST", {}), api(`purchase-orders/${id}/receive`, "POST", {}),
    ]);
    assert.deepEqual(responses.map(r => r.status).sort(), [200, 400]);
    const erp = JSON.parse(fs.readFileSync(server.dataFile.replace(/\.json$/, "-erp.json"), "utf8"));
    const accounting = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(erp.stockLedger.filter(row => row.refId === id).length, 1);
    assert.equal(accounting.taxInvoices.filter(row => row.sourceId === id).length, 1);
    assert.equal(erp.purchaseOrders.find(row => row.id === id).taxInvoiceId,
      accounting.taxInvoices.find(row => row.sourceId === id).id);
  });

  await t.test("failed purchase-request conversion is not published in memory and can be retried", async () => {
    const pr = await request();
    assert.equal((await api(`purchase-requests/${pr.id}/approve`, "POST", {})).status, 200);
    const file = server.dataFile.replace(/\.json$/, "-erp.json");
    const backup = file + ".convert-test-backup";
    fs.renameSync(file, backup);
    fs.mkdirSync(file);
    try {
      const failed = await api(`purchase-requests/${pr.id}/convert-to-po`, "POST", {
        partnerName: "Test supplier", locationId: location.id,
      });
      assert.equal(failed.status, 500);
      const current = (await api("purchase-requests")).purchaseRequests.find(r => r.id === pr.id);
      assert.equal(current.status, "approved", "failed persistence must not publish converted in memory");
      assert.equal((await api("purchase-orders")).purchaseOrders.some(po => po.sourcePurchaseRequestId === pr.id), false);
    } finally {
      fs.rmdirSync(file);
      fs.renameSync(backup, file);
    }
    const retried = await api(`purchase-requests/${pr.id}/convert-to-po`, "POST", {
      partnerName: "Test supplier", locationId: location.id,
    });
    assert.equal(retried.status, 200, JSON.stringify(retried));
    assert.equal(retried.purchaseOrder.sourcePurchaseRequestId, pr.id);
  });

  await t.test("failed file persistence does not publish an approval in memory and can be retried", async () => {
    const pr = await request();
    const file = server.dataFile.replace(/\.json$/, "-erp.json");
    const backup = file + ".test-backup";
    // Block only the disposable test server's atomic rename destination.
    fs.renameSync(file, backup);
    fs.mkdirSync(file);
    try {
      assert.equal((await api(`purchase-requests/${pr.id}/approve`, "POST", {})).status, 500);
      assert.equal((await api("purchase-requests")).purchaseRequests.find(r => r.id === pr.id).status, "pending");
    } finally {
      fs.rmdirSync(file);
      fs.renameSync(backup, file);
    }
    assert.equal((await api(`purchase-requests/${pr.id}/approve`, "POST", {})).status, 200);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).purchaseRequests.find(r => r.id === pr.id).status, "approved");
  });
});

const ADMIN_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!ADMIN_DATABASE_URL) {
  test("ERP document strict company scope — PostgreSQL (skipped: no test DB)", { skip: true }, () => {});
} else {
  const { Client } = require("pg");
  test("ERP transition commands fail closed for foreign-company and legacy NULL rows", async t => {
    const dbName = `hrtest_erp_scope_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
    const base = ADMIN_DATABASE_URL.replace(/\/[^/]*(\?.*)?$/, "");
    const testDbUrl = `${base}/${dbName}`;
    const admin = new Client({ connectionString: ADMIN_DATABASE_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    let server;
    let db;
    t.after(async () => {
      try {
        // Close known clients before terminating unknown stragglers. Reversing
        // this order makes their own teardown reject with PostgreSQL 57P01.
        if (server) await server.stop();
        if (db) await db.end();
        await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()", [dbName]);
        await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
      } finally { await admin.end(); }
    });

    server = await startServer({ env: { DATABASE_URL: testDbUrl } });
    const register = async (companyName, loginId) => {
      const response = await fetch(server.baseUrl + "/api/companies/register", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyName, adminName: "관리자", loginId, password: "AdminPassw0rd1" }),
      });
      const body = await response.json();
      assert.equal(body.ok, true, JSON.stringify(body));
      const tokenBody = JSON.parse(Buffer.from(body.token.split(".")[0], "base64url").toString("utf8"));
      return { ...body, companyId: tokenBody.companyId };
    };
    const companyA = await register("ERP 범위 회사 A", "erp_scope_a");
    const companyB = await register("ERP 범위 회사 B", "erp_scope_b");
    db = new Client({ connectionString: testDbUrl });
    await db.connect();
    // Fresh schema is NOT NULL. Drop it only inside this disposable DB to model a
    // pre-backfill legacy row and prove commands do not adopt it implicitly.
    for (const table of ["erp_quotations", "erp_purchase_orders", "erp_purchase_requests"]) {
      await db.query(`ALTER TABLE ${table} ALTER COLUMN company_id DROP NOT NULL`);
    }
    const rows = [
      ["erp_quotations", "foreign-quote-draft", "draft", companyB.companyId],
      ["erp_quotations", "null-quote-accepted", "accepted", null],
      ["erp_purchase_orders", "foreign-po-draft", "draft", companyB.companyId],
      ["erp_purchase_orders", "null-po-ordered", "ordered", null],
      ["erp_purchase_requests", "foreign-pr-approved", "approved", companyB.companyId],
      ["erp_purchase_requests", "null-pr-approved", "approved", null],
    ];
    for (const [table, id, status, companyId] of rows) {
      await db.query(`INSERT INTO ${table}(id,doc_date,status,data,company_id) VALUES($1,'2031-05-01',$2,$3,$4)`,
        [id, status, { id, status, date: "2031-05-01", lines: [] }, companyId]);
    }
    const command = async (path, body = {}) => {
      const response = await fetch(server.baseUrl + "/api/erp/" + path, {
        method: "POST", headers: { Authorization: `Bearer ${companyA.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    };
    const attempts = [
      ["quotations/foreign-quote-draft/send", {}],
      ["quotations/null-quote-accepted/ship", {}],
      ["purchase-orders/foreign-po-draft/confirm", {}],
      ["purchase-orders/null-po-ordered/receive", {}],
      ["purchase-requests/foreign-pr-approved/convert-to-po", { partnerName: "공급사", locationId: "loc" }],
      ["purchase-requests/null-pr-approved/convert-to-po", { partnerName: "공급사", locationId: "loc" }],
    ];
    for (const [path, body] of attempts) {
      const result = await command(path, body);
      assert.equal(result.status, 404, `${path}: ${JSON.stringify(result.body)}`);
    }
    for (const [table, id, status] of rows) {
      const result = await db.query(`SELECT status FROM ${table} WHERE id=$1`, [id]);
      assert.equal(result.rows[0].status, status, `${table}/${id} must remain unchanged`);
    }
  });
}

