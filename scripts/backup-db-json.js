"use strict";

// PostgreSQL 클라이언트 도구(pg_dump)를 설치할 수 없는 환경을 위한 읽기 전용 JSON 백업.
// - DATABASE_URL만 사용하며 URL/비밀번호는 출력하지 않는다.
// - Render PostgreSQL처럼 SSL이 필요한 DB에 접속할 수 있도록 sslmode=require를 보강한다.
// - OneDrive가 있으면 기본 저장 위치를 OneDrive\DB-Backups\hr-system 으로 잡는다.
// - 이 백업은 "긴급 안전 사본" 성격이다. 장기 운영/완전 복구 표준은 pg_dump가 더 적합하다.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

let Client;
try {
  ({ Client } = require("pg"));
} catch (err) {
  console.error("[backup-db-json] pg 모듈을 찾지 못했습니다.");
  console.error("먼저 프로젝트 폴더에서 `npm.cmd ci --include=optional` 또는 `npm install`을 실행하세요.");
  process.exit(1);
}

const TABLES = [
  "app_meta",
  "companies",
  "platform_admins",
  "master_audit_log",
  "company_features",
  "employees",
  "employee_history",
  "kpi_entries",
  "kpi_history",
  "accounts",
  "partners",
  "vouchers",
  "voucher_seq",
  "tax_invoices",
  "tax_invoice_seq",
  "rcps_issuances",
  "rcps_amortization_schedule",
  "rcps_fair_value_valuations",
  "fixed_assets",
  "fixed_asset_depreciation_schedule",
  "erp_items",
  "erp_locations",
  "erp_quotations",
  "erp_quote_seq",
  "erp_purchase_orders",
  "erp_po_seq",
  "erp_purchase_requests",
  "erp_stock_ledger",
  "erp_sales_targets",
  "pms_projects",
  "pms_allocations",
  "pms_worklogs",
  "recruit_jobs",
  "recruit_candidates",
  "recruit_interviews",
  "app_collections",
  "app_singletons",
  "annual_snapshots",
  "budget_store",
  "activity_log",
  "api_idempotency",
];

function _stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").replace("Z", "Z");
}

function _defaultBackupDir() {
  const candidates = [
    process.env.BACKUP_DIR,
    process.env.OneDrive,
    process.env.OneDriveCommercial,
    process.env.OneDriveConsumer,
  ].filter(Boolean);
  const base = candidates[0] || path.join(os.homedir(), "OneDrive");
  return process.env.BACKUP_DIR ? base : path.join(base, "DB-Backups", "hr-system");
}

function _connectionString() {
  const raw = process.env.DATABASE_URL || process.env.TEST_DATABASE_URL;
  if (!raw) {
    console.error("[backup-db-json] DATABASE_URL이 필요합니다.");
    console.error("예: $env:DATABASE_URL = 'postgresql://...' 설정 후 다시 실행하세요.");
    process.exit(1);
  }
  const url = new URL(raw);
  if (!url.searchParams.has("sslmode")) url.searchParams.set("sslmode", "require");
  return url.toString();
}

function _quoteIdent(name) {
  return `"${String(name).replace(/"/g, "\"\"")}"`;
}

function _safeOrderBy(columns) {
  const preferred = ["id", "company_id", "created_at", "updated_at", "year", "seq"];
  const selected = preferred.filter(name => columns.includes(name));
  return selected.length ? ` ORDER BY ${selected.map(_quoteIdent).join(", ")}` : "";
}

async function _tableExists(client, table) {
  const { rows } = await client.query(
    "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1) AS exists",
    [table]
  );
  return rows[0]?.exists === true;
}

async function _columns(client, table) {
  const { rows } = await client.query(
    "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position",
    [table]
  );
  return rows.map(r => r.column_name);
}

async function main() {
  const outDir = _defaultBackupDir();
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = process.env.BACKUP_FILE || path.join(outDir, `hrsystem-db-json-${_stamp()}.json`);
  const checksumFile = `${outFile}.sha256`;
  const connectionString = _connectionString();

  const client = new Client({
    connectionString,
    // Render External Database URL은 TLS가 필요하다. 사내 SSL 프록시/루트 인증서 문제로
    // Windows Node가 체인을 검증하지 못하는 경우가 있어 백업 스크립트에서는 접속 안정성을
    // 우선한다. 비밀번호는 connectionString에만 있고 로그/파일 metadata에는 쓰지 않는다.
    ssl: { rejectUnauthorized: false },
  });

  const backup = {
    type: "hr-system-json-backup",
    exportedAt: new Date().toISOString(),
    formatVersion: 1,
    note: "JSON safety backup created without pg_dump. Prefer pg_dump custom archives for full production restore.",
    source: {
      database: null,
      user: null,
      host: null,
    },
    tables: {},
    errors: [],
  };

  await client.connect();
  try {
    const identity = await client.query("SELECT current_database() AS database, current_user AS \"user\", inet_server_addr()::text AS host");
    backup.source = identity.rows[0] || backup.source;

    for (const table of TABLES) {
      if (!await _tableExists(client, table)) {
        backup.tables[table] = { exists: false, columns: [], rows: [] };
        console.log(`${table}: table not found`);
        continue;
      }
      const columns = await _columns(client, table);
      const sql = `SELECT * FROM ${_quoteIdent(table)}${_safeOrderBy(columns)}`;
      const { rows } = await client.query(sql);
      backup.tables[table] = { exists: true, columns, rows };
      console.log(`${table}: ${rows.length} rows`);
    }
  } catch (err) {
    backup.errors.push({ message: err.message, code: err.code || null });
    throw err;
  } finally {
    await client.end().catch(() => {});
  }

  const json = JSON.stringify(backup, null, 2);
  fs.writeFileSync(outFile, json, "utf8");
  const hash = crypto.createHash("sha256").update(json).digest("hex");
  fs.writeFileSync(checksumFile, `${hash}  ${path.basename(outFile)}\n`, "utf8");

  console.log("");
  console.log(`[backup-db-json] 백업 완료: ${outFile}`);
  console.log(`[backup-db-json] SHA256: ${checksumFile}`);
  console.log("[backup-db-json] 주의: 이 파일에는 인사/급여/회계 정보와 비밀번호 해시/2FA secret 등 민감정보가 포함될 수 있습니다.");
}

main().catch(err => {
  console.error(`[backup-db-json] 실패: ${err.message}`);
  process.exit(1);
});
