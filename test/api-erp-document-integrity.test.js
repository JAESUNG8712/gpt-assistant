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
  const erpFile = server.dataFile.replace(/\.json$/, "-erp.json");
  const disk = () => JSON.parse(fs.readFileSync(erpFile, "utf8"));
  async function failAndRetry(route, body, listRoute, field) {
    const list = async () => {
      const reply = await api(listRoute);
      assert.equal(reply.status, 200, JSON.stringify(reply));
      assert.ok(Array.isArray(reply[field]), field);
      return reply[field];
    };
    const before = await list();
    const backup = erpFile + ".retry-test";
    fs.renameSync(erpFile, backup);
    fs.mkdirSync(erpFile);
    try {
      const failed = await api(route, "POST", body);
      assert.equal(failed.status, 500, JSON.stringify(failed));
      assert.deepEqual(await list(), before, route + " must not publish a failed write");
    } finally {
      fs.rmdirSync(erpFile);
      fs.renameSync(backup, erpFile);
    }
    const reply = await api(route, "POST", body);
    assert.equal(reply.status, 200, JSON.stringify(reply));
    assert.equal(reply.ok, true, JSON.stringify(reply));
    return { before, after: await list(), reply };
  }
  await t.test("failed document creation, sending and confirmation leave no duplicate or skipped number", async () => {
    const body = { ...input, partnerName: "Retry partner", locationId: location.id };
    const documents = {};
    for (const [route, list, field] of [
      ["quotations", "quotations", "quotation"],
      ["purchase-orders", "purchaseOrders", "purchaseOrder"],
      ["purchase-requests", "purchaseRequests", "purchaseRequest"],
    ]) {
      const { before, after, reply } = await failAndRetry(route, body, route, list);
      const document = reply[field];
      documents[route] = document;
      assert.equal(after.length, before.length + 1);
      assert.deepEqual(after.find(row => row.id === document.id), document);
      assert.equal(disk()[list].filter(row => row.id === document.id).length, 1);
    }
    for (const [route, list, action, numberField, counter, prefix, status] of [
      ["quotations", "quotations", "send", "quoteNo", "quoteSeq", "QT", "sent"],
      ["purchase-orders", "purchaseOrders", "confirm", "poNo", "poSeq", "PO", "ordered"],
    ]) {
      const { id } = documents[route];
      const prior = disk()[counter];
      const { after } = await failAndRetry(`${route}/${id}/${action}`, {}, route, list);
      const saved = after.find(row => row.id === id);
      assert.equal(saved.status, status);
      const [docPrefix, year, sequence] = saved[numberField].split("-");
      assert.equal(docPrefix, prefix);
      assert.equal(Number(sequence), (prior[year] || 0) + 1);
      assert.equal(disk()[counter][year], Number(sequence));
      assert.deepEqual(disk()[list].find(row => row.id === id), saved);
    }
  });
  await t.test("failed stock movements leave the ledger unchanged; count and transfer retries write complete sets", async () => {
    const destination = (await api("locations", "POST", { name: "Destination" })).location;
    const second = (await api("items", "POST", { code: "COUNT-SECOND", name: "Second counted item" })).item;
    const source = { itemId: item.id, locationId: location.id };
    for (const [route, body, expected] of [
      ["stock/adjust", { ...source, type: "in", qty: 9 }, [[item.id, location.id, "in", 9]]],
      ["stock/adjust", { ...source, type: "out", qty: 2 }, [[item.id, location.id, "out", 2]]],
      ["stock/count", { locationId: location.id, lines: [{ itemId: item.id, countedQty: 8 }, { itemId: second.id, countedQty: 4 }] },
        [[item.id, location.id, "in", 1], [second.id, location.id, "in", 4]]],
      ["stock/transfer", { itemId: item.id, fromLocationId: location.id, toLocationId: destination.id, qty: 3 },
        [[item.id, location.id, "out", 3], [item.id, destination.id, "in", 3]]],
    ]) {
      const { before, after, reply } = await failAndRetry(route, body, "stock/ledger", "ledger");
      const priorIds = new Set(before.map(row => row.id));
      const entries = disk().stockLedger.filter(row => !priorIds.has(row.id));
      assert.equal(after.length, before.length + expected.length);
      assert.deepEqual(entries.map(row => [row.itemId, row.locationId, row.type, row.qty]), expected);
      for (const entry of entries) assert.deepEqual(after.find(row => row.id === entry.id), entry);
      if (route === "stock/transfer") assert.ok(entries.every(entry => entry.refId === reply.transferId && entry.refType === "transfer"));
    }
  });
  await t.test("sales target create, update and delete retries agree with the persisted list", async () => {
    const route = "sales-targets";
    const target = { year: 2031, month: 5, targetAmount: 1000, memo: "Retry target" };
    const created = await failAndRetry(route, target, route, "salesTargets");
    const { id } = created.reply.salesTarget;
    assert.equal(created.after.length, created.before.length + 1);
    assert.deepEqual(disk().salesTargets, created.after);
    const updated = await failAndRetry(route, { ...target, id, targetAmount: 2500 }, route, "salesTargets");
    assert.equal(updated.after.length, created.after.length);
    assert.equal(updated.after.find(row => row.id === id).targetAmount, 2500);
    assert.deepEqual(disk().salesTargets, updated.after);
    const removed = await failAndRetry(`${route}/${id}/delete`, {}, route, "salesTargets");
    assert.deepEqual(removed.after, created.before);
    assert.deepEqual(disk().salesTargets, removed.after);
  });
  await t.test("an invalid count batch writes nothing; an explicit zero clears the counted stock", async () => {
    const counted = (await api("items", "POST", { code: "COUNT-ZERO", name: "Zero count item" })).item;
    const initial = { itemId: counted.id, locationId: location.id, type: "in", qty: 4 };
    assert.equal((await api("stock/adjust", "POST", initial)).status, 200);
    const before = disk().stockLedger;
    const beforeList = (await api("stock/ledger")).ledger;
    const good = { itemId: item.id, countedQty: 123 };
    for (const invalid of [
      { ...good, countedQty: 55 }, null, { itemId: "", countedQty: 0 },
      { itemId: counted.id }, { itemId: counted.id, countedQty: null },
      { itemId: counted.id, countedQty: " " }, { itemId: counted.id, countedQty: "Infinity" },
    ]) {
      const result = await api("stock/count", "POST", { locationId: location.id, lines: [good, invalid] });
      assert.equal(result.status, 400, JSON.stringify({ invalid, result }));
      assert.deepEqual((await api("stock/ledger")).ledger, beforeList);
      assert.deepEqual(disk().stockLedger, before);
    }
    const countedZero = await api("stock/count", "POST", {
      locationId: location.id, lines: [{ itemId: counted.id, countedQty: 0 }],
    });
    assert.equal(countedZero.status, 200, JSON.stringify(countedZero));
    assert.equal(countedZero.adjusted, 1);
    const additions = disk().stockLedger.slice(before.length);
    assert.deepEqual(additions.map(row => [row.itemId, row.locationId, row.type, row.qty]), [[counted.id, location.id, "out", 4]]);
  });
  await t.test("failed item and warehouse writes retain the saved list; retries persist once", async () => {
    const file = server.dataFile.replace(/\.json$/, "-erp.json");
    const unusedItem = (await api("items", "POST", { code: "UNUSED", name: "Unused item" })).item;
    const unusedWarehouse = (await api("locations", "POST", { name: "Unused warehouse" })).location;
    for (const [collection, original] of [["items", unusedItem], ["locations", unusedWarehouse]]) {
      const created = { ...original, id: "master-retry", code: "RETRY", name: "Retry record" };
      const edited = { ...original, name: "Updated record" };
      const before = (await api(collection))[collection];
      const backup = file + ".master-test";
      fs.renameSync(file, backup);
      fs.mkdirSync(file);
      try {
        assert.equal((await api(collection, "POST", created)).status, 500);
        assert.equal((await api(collection, "POST", edited)).status, 500);
        assert.equal((await api(`${collection}/${original.id}/delete`, "POST", {})).status, 500);
        assert.deepEqual((await api(collection))[collection], before);
      } finally {
        fs.rmdirSync(file);
        fs.renameSync(backup, file);
      }
      assert.equal((await api(collection, "POST", created)).status, 200);
      assert.equal((await api(collection, "POST", edited)).status, 200);
      const saved = JSON.parse(fs.readFileSync(file, "utf8"))[collection];
      assert.equal(saved.filter(row => row.id === created.id).length, 1);
      assert.equal(saved.find(row => row.id === original.id).name, edited.name);
      assert.equal((await api(`${collection}/${created.id}/delete`, "POST", {})).status, 200);
      assert.ok(!JSON.parse(fs.readFileSync(file, "utf8"))[collection].some(row => row.id === created.id));
    }
  });
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
