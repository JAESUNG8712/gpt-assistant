// One-time migration: JSON file storage → PostgreSQL.
//
// Usage:
//   DATABASE_URL=postgres://... node scripts/migrate-to-db.js
//   (optionally DATA_FILE=/path/to/hr-data.json if not using the default)
//
// Safe to re-run: every insert uses ON CONFLICT so existing rows are updated
// rather than duplicated. The source JSON files are never modified or deleted.
"use strict";
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");
const { GENERIC_LIST_FIELDS, SINGLETON_FIELDS } = require("../lib/collections");

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL이 설정되어 있지 않습니다. 예: DATABASE_URL=postgres://... node scripts/migrate-to-db.js");
  process.exit(1);
}

const JSON_FILE = process.env.DATA_FILE || path.join(__dirname, "..", "hr-data.json");
const sidecar = (suffix) => JSON_FILE.replace(/\.json$/, `-${suffix}.json`);

function readJsonIfExists(file, fallback) {
  if (!fs.existsSync(file)) {
    console.log(`  (없음, 건너뜀) ${path.basename(file)}`);
    return fallback;
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    console.warn(`  ⚠ ${path.basename(file)} 파싱 실패: ${e.message}`);
    return fallback;
  }
}

function isHashedPw(pw) {
  return typeof pw === "string" && /^\$2[aby]\$/.test(pw);
}
async function hashPlaintextPw(pw) {
  return isHashedPw(pw) ? pw : await bcrypt.hash(pw, 10);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function migrateMainData() {
  console.log("\n[1/5] 메인 데이터 (employees, kpiEntries, 일반 컬렉션, 설정값)");
  const data = readJsonIfExists(JSON_FILE, null);
  if (!data) return;
  const history = readJsonIfExists(sidecar("history"), { employees: [], kpi: [] });

  let empCount = 0, kpiCount = 0, collCount = 0, singCount = 0;

  for (const rawEmp of (data.employees || [])) {
    if (!rawEmp.id) continue;
    const pw = rawEmp.pw != null && rawEmp.pw !== "" ? await hashPlaintextPw(rawEmp.pw) : rawEmp.pw;
    const emp = { ...rawEmp, pw };
    await pool.query(
      `INSERT INTO employees (id, data) VALUES ($1,$2)
       ON CONFLICT (id) DO UPDATE SET data = $2, updated_at = NOW()`,
      [String(emp.id), emp]
    );
    empCount++;
  }
  for (const entry of (history.employees || [])) {
    await pool.query(
      "INSERT INTO employee_history (employee_id, action, changed_by, changed_at, data) VALUES ($1,$2,$3,$4,$5)",
      [String(entry.employee_id), entry.action, entry.changed_by, entry.changed_at || new Date().toISOString(), entry.data]
    );
  }

  for (const kpi of (data.kpiEntries || [])) {
    if (!kpi.id) continue;
    const empId = kpi.employeeId || kpi.employee_id || null;
    const evalYear = kpi.year ? parseInt(kpi.year) : null;
    await pool.query(
      `INSERT INTO kpi_entries (id, employee_id, eval_year, data) VALUES ($1,$2,$3,$4)
       ON CONFLICT (id) DO UPDATE SET data = $4, employee_id = $2, eval_year = $3, updated_at = NOW()`,
      [String(kpi.id), empId, evalYear, kpi]
    );
    kpiCount++;
  }
  for (const entry of (history.kpi || [])) {
    await pool.query(
      "INSERT INTO kpi_history (kpi_id, action, changed_by, changed_at, data) VALUES ($1,$2,$3,$4,$5)",
      [String(entry.kpi_id), entry.action, entry.changed_by, entry.changed_at || new Date().toISOString(), entry.data]
    );
  }

  for (const field of GENERIC_LIST_FIELDS) {
    for (const item of (data[field] || [])) {
      if (!item || item.id == null) continue;
      await pool.query(
        `INSERT INTO app_collections (collection, id, data) VALUES ($1,$2,$3)
         ON CONFLICT (collection, id) DO UPDATE SET data = $3, updated_at = NOW()`,
        [field, String(item.id), JSON.stringify(item)]
      );
      collCount++;
    }
  }

  for (const key of SINGLETON_FIELDS) {
    if (data[key] === undefined) continue;
    await pool.query(
      `INSERT INTO app_singletons (key, data) VALUES ($1,$2)
       ON CONFLICT (key) DO UPDATE SET data = $2, updated_at = NOW()`,
      [key, JSON.stringify(data[key])]
    );
    singCount++;
  }

  const version = data._version || 0;
  await pool.query(
    "INSERT INTO app_meta (key, value) VALUES ('data_version', $1) ON CONFLICT (key) DO UPDATE SET value = $1",
    [String(version)]
  );

  console.log(`  ✓ employees ${empCount}건, kpiEntries ${kpiCount}건, 일반 컬렉션 ${collCount}건, 설정값 ${singCount}건, 버전=${version}`);
}

async function migrateSnapshots() {
  console.log("\n[2/5] 연간 확정 스냅샷");
  const snaps = readJsonIfExists(sidecar("snapshots"), {});
  let n = 0;
  for (const [yearStr, s] of Object.entries(snaps)) {
    const yr = parseInt(yearStr);
    if (!yr) continue;
    await pool.query(
      `INSERT INTO annual_snapshots (eval_year, snapshot_data, emp_count, kpi_count, confirmed_by, confirmed_at, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (eval_year) DO UPDATE SET
         snapshot_data = $2, emp_count = $3, kpi_count = $4, confirmed_by = $5, confirmed_at = $6, notes = $7`,
      [yr, s.data, s.empCount || 0, s.kpiCount || 0, s.confirmedBy || null, s.createdAt || new Date().toISOString(), s.label || null]
    );
    n++;
  }
  console.log(`  ✓ ${n}건`);
}

async function migrateAccounting() {
  console.log("\n[3/5] 회계 모듈 (계정과목/거래처/전표/세금계산서)");
  const acct = readJsonIfExists(sidecar("accounting"), null);
  if (!acct) return;

  let n = { accounts: 0, partners: 0, vouchers: 0, taxInvoices: 0 };
  for (const a of (acct.accounts || [])) {
    await pool.query(
      `INSERT INTO accounts (id, data) VALUES ($1,$2)
       ON CONFLICT (id) DO UPDATE SET data = $2, updated_at = NOW()`,
      [String(a.id), a]
    );
    n.accounts++;
  }
  for (const p of (acct.partners || [])) {
    await pool.query(
      `INSERT INTO partners (id, data) VALUES ($1,$2)
       ON CONFLICT (id) DO UPDATE SET data = $2, updated_at = NOW()`,
      [String(p.id), p]
    );
    n.partners++;
  }
  for (const v of (acct.vouchers || [])) {
    const voucherNo = v.voucherNo || `DRAFT-${v.id}`;
    await pool.query(
      `INSERT INTO vouchers (id, voucher_no, voucher_date, status, data) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (id) DO UPDATE SET voucher_no = $2, voucher_date = $3, status = $4, data = $5, updated_at = NOW()`,
      [String(v.id), voucherNo, v.date, v.status || "draft", v]
    );
    n.vouchers++;
  }
  for (const inv of (acct.taxInvoices || [])) {
    const invoiceNo = inv.invoiceNo || `DRAFT-${inv.id}`;
    await pool.query(
      `INSERT INTO tax_invoices (id, invoice_no, issue_date, status, data) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (id) DO UPDATE SET invoice_no = $2, issue_date = $3, status = $4, data = $5, updated_at = NOW()`,
      [String(inv.id), invoiceNo, inv.issueDate, inv.status || "issued", inv]
    );
    n.taxInvoices++;
  }
  for (const [year, seq] of Object.entries(acct.voucherSeq || {})) {
    await pool.query(
      "INSERT INTO voucher_seq (year, seq) VALUES ($1,$2) ON CONFLICT (year) DO UPDATE SET seq = $2",
      [parseInt(year), seq]
    );
  }
  for (const [year, seq] of Object.entries(acct.taxInvoiceSeq || {})) {
    await pool.query(
      "INSERT INTO tax_invoice_seq (year, seq) VALUES ($1,$2) ON CONFLICT (year) DO UPDATE SET seq = $2",
      [parseInt(year), seq]
    );
  }
  console.log(`  ✓ 계정과목 ${n.accounts}건, 거래처 ${n.partners}건, 전표 ${n.vouchers}건, 세금계산서 ${n.taxInvoices}건`);
}

async function migrateErp() {
  console.log("\n[4/5] ERP 모듈 (품목/창고/견적/발주/구매요청/재고이력/영업목표)");
  const erp = readJsonIfExists(sidecar("erp"), null);
  if (!erp) return;

  let n = { items: 0, locations: 0, quotations: 0, pos: 0, prs: 0, stock: 0, targets: 0 };
  for (const it of (erp.items || [])) {
    await pool.query(
      `INSERT INTO erp_items (id, data) VALUES ($1,$2)
       ON CONFLICT (id) DO UPDATE SET data = $2, updated_at = NOW()`,
      [String(it.id), it]
    );
    n.items++;
  }
  for (const l of (erp.locations || [])) {
    await pool.query(
      `INSERT INTO erp_locations (id, data) VALUES ($1,$2)
       ON CONFLICT (id) DO UPDATE SET data = $2, updated_at = NOW()`,
      [String(l.id), l]
    );
    n.locations++;
  }
  for (const q of (erp.quotations || [])) {
    await pool.query(
      `INSERT INTO erp_quotations (id, doc_date, status, data) VALUES ($1,$2,$3,$4)
       ON CONFLICT (id) DO UPDATE SET doc_date = $2, status = $3, data = $4, updated_at = NOW()`,
      [String(q.id), q.date, q.status || "draft", q]
    );
    n.quotations++;
  }
  for (const po of (erp.purchaseOrders || [])) {
    await pool.query(
      `INSERT INTO erp_purchase_orders (id, doc_date, status, data) VALUES ($1,$2,$3,$4)
       ON CONFLICT (id) DO UPDATE SET doc_date = $2, status = $3, data = $4, updated_at = NOW()`,
      [String(po.id), po.date, po.status || "draft", po]
    );
    n.pos++;
  }
  for (const pr of (erp.purchaseRequests || [])) {
    await pool.query(
      `INSERT INTO erp_purchase_requests (id, doc_date, status, data) VALUES ($1,$2,$3,$4)
       ON CONFLICT (id) DO UPDATE SET doc_date = $2, status = $3, data = $4, updated_at = NOW()`,
      [String(pr.id), pr.date, pr.status || "pending", pr]
    );
    n.prs++;
  }
  for (const sl of (erp.stockLedger || [])) {
    if (!sl.id) continue;
    await pool.query(
      `INSERT INTO erp_stock_ledger (id, item_id, location_id, data) VALUES ($1,$2,$3,$4)
       ON CONFLICT (id) DO NOTHING`,
      [String(sl.id), String(sl.itemId), String(sl.locationId), sl]
    );
    n.stock++;
  }
  for (const t of (erp.salesTargets || [])) {
    await pool.query(
      `INSERT INTO erp_sales_targets (id, data) VALUES ($1,$2)
       ON CONFLICT (id) DO UPDATE SET data = $2, updated_at = NOW()`,
      [String(t.id), t]
    );
    n.targets++;
  }
  for (const [year, seq] of Object.entries(erp.quoteSeq || {})) {
    await pool.query(
      "INSERT INTO erp_quote_seq (year, seq) VALUES ($1,$2) ON CONFLICT (year) DO UPDATE SET seq = $2",
      [parseInt(year), seq]
    );
  }
  for (const [year, seq] of Object.entries(erp.poSeq || {})) {
    await pool.query(
      "INSERT INTO erp_po_seq (year, seq) VALUES ($1,$2) ON CONFLICT (year) DO UPDATE SET seq = $2",
      [parseInt(year), seq]
    );
  }
  console.log(`  ✓ 품목 ${n.items}건, 창고 ${n.locations}건, 견적 ${n.quotations}건, 발주 ${n.pos}건, 구매요청 ${n.prs}건, 재고이력 ${n.stock}건, 영업목표 ${n.targets}건`);
}

async function migratePms() {
  console.log("\n[5/5] PMS 모듈 (프로젝트/투입률)");
  const pms = readJsonIfExists(sidecar("pms"), null);
  if (!pms) return;

  let n = { projects: 0, allocations: 0, worklogs: 0 };
  for (const p of (pms.projects || [])) {
    await pool.query(
      `INSERT INTO pms_projects (id, data) VALUES ($1,$2)
       ON CONFLICT (id) DO UPDATE SET data = $2, updated_at = NOW()`,
      [String(p.id), p]
    );
    n.projects++;
  }
  for (const a of (pms.allocations || [])) {
    await pool.query(
      `INSERT INTO pms_allocations (id, employee_id, year, month, data) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (id) DO UPDATE SET data = $5, updated_at = NOW()`,
      [String(a.id), String(a.employeeId), Number(a.year), Number(a.month), a]
    );
    n.allocations++;
  }
  for (const w of (pms.worklogs || [])) {
    await pool.query(
      `INSERT INTO pms_worklogs (id, employee_id, work_date, data) VALUES ($1,$2,$3,$4)
       ON CONFLICT (id) DO UPDATE SET data = $4, updated_at = NOW()`,
      [String(w.id), String(w.employeeId), w.date, w]
    );
    n.worklogs++;
  }
  console.log(`  ✓ 프로젝트 ${n.projects}건, 투입률 배정 ${n.allocations}건, 일일 업무 투입 ${n.worklogs}건`);
}

async function main() {
  console.log(`JSON 파일 → PostgreSQL 마이그레이션 시작 (소스: ${JSON_FILE})`);
  const schema = fs.readFileSync(path.join(__dirname, "..", "schema.sql"), "utf8");
  await pool.query(schema);
  console.log("스키마 확인/생성 완료.");

  await migrateMainData();
  await migrateSnapshots();
  await migrateAccounting();
  await migrateErp();
  await migratePms();

  console.log("\n마이그레이션 완료. 원본 JSON 파일은 그대로 보존되었습니다.");
  console.log("이제 서버를 DATABASE_URL 환경변수와 함께 재시작하면 DB 모드로 동작합니다.");
  await pool.end();
}

main().catch((e) => {
  console.error("\n마이그레이션 실패:", e);
  process.exit(1);
});
