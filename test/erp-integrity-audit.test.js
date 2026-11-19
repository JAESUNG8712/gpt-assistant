"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { promisify } = require("node:util");
const execFile = promisify(require("node:child_process").execFile);
const { inspectErp, COLLECTIONS } = require("../lib/erp-integrity-audit");
const { auditPostgres, parseArgs, TABLES } = require("../scripts/audit-erp-integrity");
const { getTestTempRoot } = require("./support/start-server");
function clean() {
  return { items: [{ id: "item", code: "SKU", active: false }], locations: [{ id: "warehouse" }],
    quotations: [{ id: "free", status: "draft", lines: [{ name: "Free text", qty: 1, unitPrice: 0 }] }],
    purchaseOrders: [], purchaseRequests: [], stockLedger: [{ id: "stock", itemId: "item", locationId: "warehouse", type: "in", qty: 2 }] };
}
test("audit keeps valid free-text quotes, inactive masters and source snapshot intact", () => {
  const source = clean(), before = structuredClone(source);
  const report = inspectErp(source);
  assert.equal(report.totalFindings, 0);
  assert.deepEqual(source, before);
  assert.equal(report.balanceChecksComplete, true);
});
test("audit finds broken refs, repeated IDs/codes, broken links, invalid and negative stock", () => {
  const source = clean();
  source.items.push({ id: "a", code: "DUP" }, { id: "b", code: " DUP " }, { id: "b", code: "OTHER" }, { id: "deleted", code: "D", _deleted: true });
  source.masterTombstones = { items: ["a"] };
  source.purchaseRequests.push({ id: "pr", status: "converted", convertedPoId: "missing", lines: [{ itemId: "deleted", qty: 1, unitPrice: 1 }] });
  source.purchaseOrders.push({ id: "po", status: "ordered", sourcePurchaseRequestId: "missing", locationId: "missing", lines: [{ itemId: "missing", qty: 1, unitPrice: -1 }] });
  source.stockLedger.push({ id: "out", itemId: "item", locationId: "warehouse", type: "out", qty: 4 }, { id: "invalid", type: "in", qty: " " });
  const codes = new Set(inspectErp(source).issues.map(issue => issue.code));
  for (const code of ["DUPLICATE_RECORD_ID", "DUPLICATE_ACTIVE_ITEM_CODE", "LIVE_TOMBSTONE", "DELETED_MASTER_REFERENCE", "BROKEN_PURCHASE_LINK", "ORPHAN_REFERENCE", "INVALID_DOCUMENT_AMOUNT", "INVALID_STOCK_ENTRY", "NEGATIVE_STOCK_BALANCE"]) assert.ok(codes.has(code), code);
});
test("report caps samples, reveals no raw data and refuses incomplete/oversized inputs", () => {
  const source = clean();
  source.stockLedger = Array.from({ length: 20 }, () => ({ id: "SECRET-ID", name: "SECRET-NAME", memo: "SECRET-MEMO", type: "out", itemId: "missing", locationId: "missing", qty: 1 }));
  const report = inspectErp(source, { sampleLimit: 2 });
  assert.ok(report.totalFindings > 20);
  assert.ok(report.issues.every(issue => issue.samples.length <= 2));
  assert.ok(report.issues.some(issue => issue.omitted > 0));
  assert.ok(!JSON.stringify(report).includes("SECRET"));
  assert.throws(() => inspectErp({ items: [] }), { code: "INCOMPLETE_SNAPSHOT" });
  assert.throws(() => inspectErp(source, { maxRows: 1 }), { code: "ROW_LIMIT_EXCEEDED" });
  assert.throws(() => parseArgs([]), { code: "CHOOSE_ONE_SOURCE" });
  assert.throws(() => parseArgs(["--file", "x", "--company-id", "x"]), { code: "CHOOSE_ONE_SOURCE" });
  assert.throws(() => parseArgs(["--company-id", "invalid"]), { code: "COMPANY_ID_REQUIRED" });
});
test("CLI reads only the named JSON, returns distinct exit codes and preserves source bytes", async t => {
  const dir = fs.mkdtempSync(path.join(getTestTempRoot(), "erp-audit-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "snapshot.json"), script = path.resolve(__dirname, "../scripts/audit-erp-integrity.js");
  const env = { ...process.env, DATABASE_URL: "postgres://secret:secret@invalid/production" };
  async function run(args) {
    try { return { code: 0, ...await execFile(process.execPath, [script, ...args], { env, timeout: 10000 }) }; }
    catch (error) { return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
  }
  const source = clean(); fs.writeFileSync(file, JSON.stringify(source));
  const before = fs.readFileSync(file);
  assert.equal((await run(["--file", file])).code, 0);
  assert.deepEqual(fs.readFileSync(file), before);
  source.stockLedger.push({ id: "negative", itemId: "item", locationId: "warehouse", type: "out", qty: 3 });
  fs.writeFileSync(file, JSON.stringify(source));
  const findings = await run(["--file", file, "--sample-limit", "0"]);
  assert.equal(findings.code, 2);
  assert.ok(JSON.parse(findings.stdout).issues.every(issue => issue.samples.length === 0));
  fs.writeFileSync(file, "SECRET malformed JSON");
  const invalid = await run(["--file", file]);
  assert.equal(invalid.code, 1);
  assert.ok(invalid.stderr.includes("INVALID_JSON"));
  assert.ok(!invalid.stderr.includes("SECRET"));
  assert.equal(fs.readFileSync(file, "utf8"), "SECRET malformed JSON");
});

for (const helper of ["erp-partial-fulfillment", "erp-quotation-discount-copy"]) {
  test("real " + helper + " remains a valid audit input", async t => {
    const { startServer, bootstrapAdminAndLogin } = require("./support/start-server");
    const server = await startServer(); t.after(() => server.stop());
    const { token } = await bootstrapAdminAndLogin(server, { loginId: "audit-admin", pw: "AuditTestPassword123!" });
    await require("./support/" + helper)(server.baseUrl, token, "auditcompat");
    const source = JSON.parse(fs.readFileSync(server.dataFile.replace(/\.json$/, "-erp.json"), "utf8"));
    assert.equal(inspectErp(source).totalFindings, 0, JSON.stringify(inspectErp(source)));
  });
}

test("PostgreSQL audit uses a stable read-only company snapshot and leaves all tables unchanged", { skip: !process.env.TEST_DATABASE_URL }, async t => {
  const { Client } = require("pg");
  const name = `hrtest_erp_audit_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
  const admin = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.connect(); await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(process.env.TEST_DATABASE_URL); url.pathname = "/" + name;
  const db = new Client({ connectionString: url.toString() });
  const writer = new Client({ connectionString: url.toString() });
  t.after(async () => { try { await db.end(); await writer.end(); await admin.query(`DROP DATABASE ${name}`); } finally { await admin.end(); } });
  await db.connect(); await writer.connect();
  const a = "11111111-1111-4111-8111-111111111111", b = "22222222-2222-4222-8222-222222222222";
  await db.query("CREATE TABLE companies(id uuid PRIMARY KEY)");
  await db.query("INSERT INTO companies VALUES($1),($2)", [a, b]);
  const source = clean();
  for (const [collection, table] of Object.entries(TABLES)) {
    await db.query(`CREATE TABLE ${table}(id text,company_id uuid,data jsonb,is_deleted boolean DEFAULT FALSE,status text,item_id text,location_id text)`);
    for (const row of source[collection]) await db.query(`INSERT INTO ${table}(id,company_id,data,status,item_id,location_id) VALUES($1,$2,$3,$4,$5,$6)`, [row.id, a, row, row.status || null, row.itemId || null, row.locationId || null]);
  }
  await db.query("INSERT INTO erp_items(id,company_id,data) VALUES('foreign',$1,'{}'),('unassigned',NULL,'{}')", [b]);
  const snapshot = async () => {
    const result = {};
    for (const table of Object.values(TABLES)) result[table] = (await db.query(`SELECT * FROM ${table} ORDER BY id`)).rows;
    return result;
  };
  const before = await snapshot(); let readonly = false;
  const checked = { query: async (...args) => {
    const result = await db.query(...args);
    if (args[0].startsWith("BEGIN")) readonly = (await db.query("SHOW transaction_read_only")).rows[0].transaction_read_only === "on";
    return result;
  } };
  const report = await auditPostgres(checked, a);
  assert.equal(readonly, true); assert.equal(report.totalFindings, 0);
  assert.equal(report.counts.items, 1); assert.equal(report.unassignedRows.items, 1);
  assert.deepEqual(await snapshot(), before);
  await assert.rejects(auditPostgres(db, a, { maxRows: 1 }), { code: "SNAPSHOT_LIMIT_EXCEEDED" });
  assert.equal((await db.query("SHOW transaction_read_only")).rows[0].transaction_read_only, "off");
  let inserted = false;
  const interleaved = { query: async (...args) => {
    const result = await db.query(...args);
    if (!inserted && args[0].startsWith("SELECT count(*)")) {
      inserted = true;
      await writer.query("INSERT INTO erp_stock_ledger(id,company_id,data,item_id,location_id) VALUES('later',$1,$2,'item','warehouse')", [a, { type: "out", qty: 9 }]);
    }
    return result;
  } };
  assert.equal((await auditPostgres(interleaved, a)).totalFindings, 0, "concurrent insert must not mix snapshots");
  assert.ok((await auditPostgres(db, a)).issues.some(issue => issue.code === "NEGATIVE_STOCK_BALANCE"));
  await writer.query("UPDATE erp_items SET data=data || '{\"id\":\"different-id\"}'::jsonb WHERE company_id=$1", [a]);
  assert.ok((await auditPostgres(db, a)).issues.some(issue => issue.code === "COLUMN_DATA_MISMATCH"));
});
