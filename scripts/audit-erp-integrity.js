"use strict";

const fs = require("node:fs");
const { inspectErp, COLLECTIONS, auditError } = require("../lib/erp-integrity-audit");
const MAX_BYTES = 50 * 1024 * 1024;
const TABLES = Object.freeze({ items: "erp_items", locations: "erp_locations", quotations: "erp_quotations",
  purchaseOrders: "erp_purchase_orders", purchaseRequests: "erp_purchase_requests", stockLedger: "erp_stock_ledger" });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readSnapshot(file) {
  const fd = fs.openSync(file, "r");
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES) throw auditError("FILE_LIMIT_EXCEEDED");
    // Bounded read even if another process grows the file after fstat.
    const buffer = Buffer.alloc(stat.size + 1);
    let size = 0, n;
    while (size < buffer.length && (n = fs.readSync(fd, buffer, size, buffer.length - size, null)) > 0) size += n;
    if (size !== stat.size) throw auditError("SNAPSHOT_CHANGED");
    try { return JSON.parse(buffer.subarray(0, size).toString("utf8").replace(/^\uFEFF/, "")); }
    catch { throw auditError("INVALID_JSON"); }
  } finally { fs.closeSync(fd); }
}

async function auditPostgres(client, companyId, options = {}) {
  if (!UUID.test(companyId || "")) throw auditError("COMPANY_ID_REQUIRED");
  const maxRows = options.maxRows ?? 50000;
  if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 50000) throw auditError("INVALID_LIMIT");
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    await client.query("SET LOCAL statement_timeout = '15s'");
    await client.query("SET LOCAL lock_timeout = '2s'");
    const company = await client.query("SELECT id FROM public.companies WHERE id = $1", [companyId]);
    if (!company.rowCount) throw auditError("COMPANY_NOT_FOUND");
    const unassignedRows = {}, snapshot = {};
    let rowCount = 0, bytes = 0;
    // Preflight and inspection share one snapshot. Oversized/partial sources
    // fail instead of generating a misleading 'clean' truncated report.
    for (const [collection, table] of Object.entries(TABLES)) {
      const stats = await client.query(
        `SELECT count(*)::int AS count, COALESCE(sum(octet_length(data::text)),0)::bigint AS bytes FROM public.${table} WHERE company_id = $1`, [companyId]);
      rowCount += Number(stats.rows[0].count);
      bytes += Number(stats.rows[0].bytes);
      if (rowCount > maxRows || bytes > MAX_BYTES) throw auditError("SNAPSHOT_LIMIT_EXCEEDED");
      const nulls = await client.query(`SELECT count(*)::int AS count FROM public.${table} WHERE company_id IS NULL`);
      unassignedRows[collection] = nulls.rows[0].count;
    }
    for (const [collection, table] of Object.entries(TABLES)) {
      const columns = collection === "items" || collection === "locations" ? ", is_deleted" :
        collection === "stockLedger" ? ", item_id, location_id" : ", status";
      const result = await client.query(`SELECT id, data${columns} FROM public.${table} WHERE company_id = $1 ORDER BY id`, [companyId]);
      snapshot[collection] = result.rows.map(row => {
        if (!row.data || typeof row.data !== "object" || Array.isArray(row.data)) return null;
        const differs = (field, value) => row.data[field] !== undefined && String(row.data[field]) !== String(value);
        const mismatch = differs("id", row.id) ||
          (collection === "stockLedger" && (differs("itemId", row.item_id) || differs("locationId", row.location_id))) ||
          (row.status !== undefined && differs("status", row.status));
        return { ...row.data, id: row.id, _deleted: row.is_deleted === true, _columnMismatch: mismatch,
          ...(collection === "stockLedger" ? { itemId: row.item_id, locationId: row.location_id } : {}),
          ...(row.status !== undefined ? { status: row.status } : {}) };
      });
    }
    const report = inspectErp(snapshot, options);
    return { ...report, source: "postgres", scope: companyId, unassignedScope: "database-wide; ownership unknown", unassignedRows };
  } finally { await client.query("ROLLBACK"); }
}

function parseArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--help") { options.help = true; continue; }
    const name = { "--file": "file", "--company-id": "companyId", "--sample-limit": "sampleLimit" }[flag];
    if (!name || options[name] !== undefined || !args[i + 1] || args[i + 1].startsWith("--")) throw auditError("INVALID_ARGUMENTS");
    options[name] = args[++i];
  }
  if (options.help) return options;
  if (!!options.file === !!options.companyId) throw auditError("CHOOSE_ONE_SOURCE");
  if (options.companyId && !UUID.test(options.companyId)) throw auditError("COMPANY_ID_REQUIRED");
  options.sampleLimit = options.sampleLimit === undefined ? 10 : Number(options.sampleLimit);
  if (!Number.isInteger(options.sampleLimit) || options.sampleLimit < 0 || options.sampleLimit > 50) throw auditError("INVALID_LIMIT");
  return options;
}

async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (options.help) {
    console.log("읽기 전용 ERP 점검 (자동 수정 없음)\nnode scripts/audit-erp-integrity.js --file <ERP JSON 사본>\nnode scripts/audit-erp-integrity.js --company-id <회사 UUID>\nPostgreSQL은 DATABASE_URL 환경변수 사용. --sample-limit 0~50 (기본 10).\n종료코드: 0=발견 없음, 2=점검 필요, 1=실행 실패/불완전.");
    return 0;
  }
  let report;
  if (options.file) report = { ...inspectErp(readSnapshot(options.file), options), source: "json", scope: "single-file" };
  else {
    if (!process.env.DATABASE_URL) throw auditError("DATABASE_URL_REQUIRED");
    // Import neither server.js nor db.js: they are application bootstrap paths.
    // Honor the operator's TLS URL settings; never disable certificate checks here.
    const { Client } = require("pg");
    const client = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000,
      query_timeout: 20000, application_name: "hr-erp-readonly-audit" });
    try { await client.connect(); report = await auditPostgres(client, options.companyId, options); }
    finally { await client.end(); }
  }
  console.log(JSON.stringify(report, null, 2));
  return report.totalFindings || Object.values(report.unassignedRows || {}).some(count => count > 0) ? 2 : 0;
}
if (require.main === module) main().then(code => { process.exitCode = code; }).catch(error => {
  // Driver/file errors can contain URLs, paths or record contents. Do not echo them.
  const code = /^[A-Z0-9_]{2,50}$/.test(error.code || "") ? error.code : "AUDIT_FAILED";
  console.error(`[erp-audit] 점검을 완료하지 못했습니다. 입력·접속 설정·스키마를 확인하세요. (${code})`);
  process.exitCode = 1;
});
module.exports = { auditPostgres, readSnapshot, parseArgs, main, TABLES, COLLECTIONS };
