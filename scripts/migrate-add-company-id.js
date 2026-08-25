// 멀티테넌트 전환 1~2단계: 기존(단일 회사) Postgres 데이터에 company_id를 백필한다.
//
// 지금까지 이 시스템은 회사 구분이 전혀 없는 단일 테넌트였다. companies 테이블과
// company_id 컬럼은 schema.sql에 이미 nullable로 추가되어 있으므로(서버 부팅 시
// 자동 적용됨), 이 스크립트는 그 nullable 컬럼에 "지금까지의 모든 데이터가 속한
// 회사" 1건을 만들어 채워 넣는 일회성 작업만 한다.
//
// 부팅마다 자동 실행되는 schema.sql의 idempotent DDL과 달리, 이 백필은 명시적으로
// 한 번만 실행하는 것이 목적이다(재실행해도 안전하지만 — 이미 company_id가 채워진
// 행은 건드리지 않음 — 매 부팅마다 돌 이유가 없다).
//
// 2단계(app_collections/app_singletons, 2026-07-21 계획 문서 "마이그레이션 순서" 2단계)
// 추가: 이 두 테이블은 1단계의 employees/kpi_entries와 달리 PRIMARY KEY 자체가
// (company_id, collection, id) / (company_id, key) 복합키로 바뀐다(schema.sql 주석
// 참고 — genId()가 회사 간에 공유되는 로컬 카운터라 id 충돌이 일상적으로 벌어지기
// 때문). Postgres는 PRIMARY KEY 컬럼에 자동으로 NOT NULL을 강제하므로, 이 백필로
// company_id의 NULL을 전부 없애기 **전까지는** schema.sql이 새 복합 PK로 전환하지
// 않고 기존 단일열 PK를 유지한 채 대기한다(스킵 로그만 남김). 따라서 운영 배포 순서는
// 반드시 다음과 같아야 한다:
//   1) 새 schema.sql/server.js를 배포하기 **전에** 기존 서버가 떠 있는 상태에서(또는
//      점검 시간을 잡고) 이 스크립트를 먼저 실행해 company_id를 전부 채운다.
//   2) 그 다음 새 server.js를 배포/재기동한다 — 이번 재기동 시 schema.sql이 NULL
//      잔여 0건을 확인하고 그제서야 복합 PK로 전환하며, 새 server.js의 upsert 쿼리
//      (`ON CONFLICT (company_id, collection, id)` 등)가 그 시점부터 정상 동작한다.
//   순서를 반대로 하면(새 server.js가 먼저 뜨는데 아직 NULL 행이 남아 PK가 구버전
//   그대로인 경우) app_collections/app_singletons에 대한 모든 쓰기가 "ON CONFLICT
//   specification과 일치하는 제약이 없다"는 오류로 실패한다.
//
// 4단계(회계/ERP/PMS/채용, 2026-07-23) 추가: 위와 동일한 두 부류로 나뉜다.
//   - 복합 PK (company_id, id) 전환 대상(id를 클라이언트가 override 가능): accounts,
//     partners, erp_items, erp_locations, erp_sales_targets, pms_projects,
//     pms_allocations, recruit_jobs — 그리고 연도별 시퀀스 4개(voucher_seq,
//     tax_invoice_seq, erp_quote_seq, erp_po_seq)는 (company_id, year) 복합 PK.
//   - 단순 필터 컬럼(NOT NULL 승격만, PK 변경 없음, id가 항상 서버 생성): vouchers,
//     tax_invoices, erp_quotations, erp_purchase_orders, erp_purchase_requests,
//     erp_stock_ledger, pms_worklogs, recruit_candidates, recruit_interviews,
//     annual_snapshots(단, PK가 아니라 UNIQUE(company_id, eval_year)로 전환).
//   배포 순서는 위 2단계와 동일 — 백필 먼저, server.js 배포/재기동은 그다음.
//
// Usage:
//   DATABASE_URL=postgres://... COMPANY_NAME="회사명" COMPANY_SLUG="company-slug" \
//     node scripts/migrate-add-company-id.js
//
//   COMPANY_SLUG 생략 시 COMPANY_NAME에서 자동 생성한다.
//
// 운영 권장 순서(읽기 전용 점검 → 명시 확인 뒤 백필):
//   DATABASE_URL=postgres://... node scripts/migrate-add-company-id.js --dry-run
//   DATABASE_URL=postgres://... COMPANY_NAME="LS티라유텍" COMPANY_SLUG="ls-tirautech" \
//     CONFIRM_COMPANY_BACKFILL="LS티라유텍" node scripts/migrate-add-company-id.js
"use strict";
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const DRY_RUN = process.argv.includes("--dry-run");

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL이 설정되어 있지 않습니다. 예: DATABASE_URL=postgres://... COMPANY_NAME=\"회사명\" node scripts/migrate-add-company-id.js");
  process.exit(1);
}
if (!DRY_RUN && !process.env.COMPANY_NAME) {
  console.error("COMPANY_NAME이 설정되어 있지 않습니다. 기존 데이터가 소속될 회사 이름을 지정하세요.");
  process.exit(1);
}
if (!DRY_RUN && process.env.CONFIRM_COMPANY_BACKFILL !== process.env.COMPANY_NAME) {
  console.error("안전 확인 실패: CONFIRM_COMPANY_BACKFILL에 COMPANY_NAME과 정확히 같은 회사명을 설정해야 합니다.");
  console.error("예: COMPANY_NAME=\"LS티라유텍\" CONFIRM_COMPANY_BACKFILL=\"LS티라유텍\" node scripts/migrate-add-company-id.js");
  process.exit(1);
}

function slugify(name) {
  return String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, "-")
    .replace(/^-+|-+$/g, "") || "company";
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// 백필 대상: company_id 컬럼이 nullable로 추가된 테이블 전체.
// 1단계: employees/kpi_entries(+history) — id 자체가 전역 유일 시퀀스라 company_id는
//        단순 필터 컬럼으로만 추가됨(PK 변경 없음).
// 2단계: app_collections/app_singletons — PRIMARY KEY 자체가 복합키로 바뀌므로(위 주석
//        참고) 백필이 끝나야 schema.sql이 그 PK 전환을 수행한다. 컬럼명이 두 테이블 다
//        동일하게 `company_id`이고, 아래 루프의 "company_id IS NULL인 행을 전부 이
//        회사로 채운다"는 UPDATE는 이 두 테이블에도 그대로 적용 가능해 같은 루프에
//        추가하는 것으로 충분하다(회사가 실제로는 하나뿐인 마이그레이션 이전 데이터라,
//        collection/id 조합의 유일성은 이미 옛 PK가 보장하고 있었으므로 백필 자체가
//        새 복합키를 위반할 일은 없다).
// 나머지 모듈(accounting/erp/pms/recruit 등)은 아직 company_id 컬럼 자체가 없어
// 후속 단계(계획 문서 3~5단계)에서 각자 다룬다 — 이 스크립트의 범위 밖.
const TABLES = [
  "employees", "kpi_entries", "employee_history", "kpi_history",
  "app_collections", "app_singletons",
  // 4단계(회계/ERP/PMS/채용) — 복합 PK 전환 대상
  "accounts", "partners", "erp_items", "erp_locations", "erp_sales_targets",
  "pms_projects", "pms_allocations", "recruit_jobs",
  "voucher_seq", "tax_invoice_seq", "erp_quote_seq", "erp_po_seq",
  // 4단계 — 단순 필터 컬럼 대상(PK 변경 없음)
  "vouchers", "tax_invoices", "erp_quotations", "erp_purchase_orders",
  "erp_purchase_requests", "erp_stock_ledger", "pms_worklogs",
  "recruit_candidates", "recruit_interviews", "annual_snapshots",
];

// 위 TABLES 중 PRIMARY KEY 자체가 복합키로 바뀌는(따라서 백필 후 schema.sql 재적용으로
// 전환 여부를 확인해야 하는) 테이블 전체 — app_collections/app_singletons(2단계) +
// 4단계 신규 12개(연도 시퀀스 4개 포함).
const COMPOSITE_PK_TABLES = [
  "app_collections", "app_singletons",
  "accounts", "partners", "erp_items", "erp_locations", "erp_sales_targets",
  "pms_projects", "pms_allocations", "recruit_jobs",
  "voucher_seq", "tax_invoice_seq", "erp_quote_seq", "erp_po_seq",
];

async function main() {
  if (DRY_RUN) {
    console.log("company_id 백필 사전 점검(읽기 전용)을 시작합니다. 데이터·스키마는 변경하지 않습니다.");
    let totalNullRows = 0;
    for (const table of TABLES) {
      const { rows } = await pool.query(
        "SELECT to_regclass($1) AS table_name",
        [`public.${table}`]
      );
      if (!rows[0].table_name) {
        console.log(`  ${table}: 테이블 없음(현재 배포 스키마에 아직 추가되지 않음)`);
        continue;
      }
      const result = await pool.query(`SELECT COUNT(*)::bigint AS count FROM ${table} WHERE company_id IS NULL`);
      const count = Number(result.rows[0].count);
      totalNullRows += count;
      console.log(`  ${table}: company_id IS NULL ${count}건`);
    }
    const companies = await pool.query("SELECT id, slug, name, status FROM companies ORDER BY created_at");
    console.log(`\n등록 회사 ${companies.rowCount}개:`);
    for (const company of companies.rows) console.log(`  ${company.id} | ${company.slug} | ${company.name} | ${company.status}`);
    console.log(`\nNULL 합계: ${totalNullRows}건`);
    console.log("단일 회사 데이터가 맞고 백업이 완료됐다면, COMPANY_NAME과 CONFIRM_COMPANY_BACKFILL을 같은 값으로 설정해 실제 백필을 실행하세요.");
    await pool.end();
    return;
  }
  console.log(`회사 백필 시작 (DATABASE_URL 대상)`);
  const schema = fs.readFileSync(path.join(__dirname, "..", "schema.sql"), "utf8");
  await pool.query(schema);
  console.log("스키마 확인/생성 완료.");

  const slug = process.env.COMPANY_SLUG || slugify(process.env.COMPANY_NAME);
  // 회사 생성과 백필을 하나의 트랜잭션으로 묶는다 — 이전에는 회사 INSERT가 별도
  // 쿼리(autocommit)로 커밋된 뒤 그 다음 백필 UPDATE가 (예: 중복 loginId로 인한
  // UNIQUE(company_id, login_id) 위반으로) 실패하면, 소속 직원이 0명인 "고아
  // companies 행"이 그대로 남는 문제가 실측 확인됐다(재실행하면 같은 slug를 재사용해
  // 실사용상 치명적이진 않지만, 실패 메시지만 보고 재시도하지 않으면 계속 남을 수
  // 있었음). 트랜잭션으로 묶으면 백필 중 어느 한 단계라도 실패 시 회사 생성까지
  // 통째로 롤백되어 항상 "전부 성공" 또는 "아무 흔적도 없음" 둘 중 하나만 남는다.
  const client = await pool.connect();
  let companyId;
  try {
    await client.query("BEGIN");
    const existing = await client.query("SELECT id FROM companies WHERE slug = $1", [slug]);
    if (existing.rows.length) {
      companyId = existing.rows[0].id;
      console.log(`기존 회사 재사용: slug="${slug}" id=${companyId}`);
    } else {
      const { rows } = await client.query(
        "INSERT INTO companies (slug, name, status) VALUES ($1,$2,'active') RETURNING id",
        [slug, process.env.COMPANY_NAME]
      );
      companyId = rows[0].id;
      console.log(`신규 회사 생성: slug="${slug}" name="${process.env.COMPANY_NAME}" id=${companyId}`);
    }

    for (const table of TABLES) {
      const before = await client.query(`SELECT COUNT(*) FROM ${table} WHERE company_id IS NULL`);
      const { rowCount } = await client.query(
        `UPDATE ${table} SET company_id = $1 WHERE company_id IS NULL`,
        [companyId]
      );
      console.log(`  ${table}: ${rowCount}건 백필 (백필 전 NULL ${before.rows[0].count}건)`);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("\n백필 실패 — 트랜잭션 전체(회사 생성 포함) 롤백됨, 고아 데이터 없음:", e.message);
    throw e;
  } finally {
    client.release();
  }

  console.log("\n백필 후 잔여 NULL 확인 (전부 0이어야 안전):");
  let allClear = true;
  for (const table of TABLES) {
    const { rows } = await pool.query(`SELECT COUNT(*) FROM ${table} WHERE company_id IS NULL`);
    const remaining = parseInt(rows[0].count, 10);
    if (remaining > 0) allClear = false;
    console.log(`  ${table}: NULL 잔여 ${remaining}건`);
  }

  const LEGACY_TABLES = ["employees", "kpi_entries", "employee_history", "kpi_history"];
  if (allClear) {
    console.log("\n모든 대상 테이블의 company_id가 채워졌습니다.");
    console.log(`NOT NULL 제약은 이 스크립트가 자동으로 걸지 않습니다(${LEGACY_TABLES.join(", ")} 한정 —`);
    console.log("데이터를 눈으로 한 번 더 확인한 뒤, 별도로 다음을 실행해 제약을 걸어주세요:");
    for (const table of LEGACY_TABLES) {
      console.log(`  ALTER TABLE ${table} ALTER COLUMN company_id SET NOT NULL;`);
    }
    // COMPOSITE_PK_TABLES는 수동 ALTER가 필요 없다 — 복합 PRIMARY KEY로 전환되는 순간
    // Postgres가 NOT NULL을 자동으로 강제한다. 백필이 방금 끝났으니 schema.sql을 한 번
    // 더 적용해(idempotent) 그 전환을 바로 이 자리에서 완료해본다 — 서버가 다음 재기동 때
    // 어차피 똑같이 하지만, 운영자가 바로 결과를 확인할 수 있도록 여기서도 시도한다.
    console.log(`\n복합 PK 전환 대상 ${COMPOSITE_PK_TABLES.length}개 테이블 전환 시도 (schema.sql 재적용)...`);
    await pool.query(schema);
    const expectedConstraints = COMPOSITE_PK_TABLES.map((t) => `${t}_pk_company`);
    const { rows: pkRows } = await pool.query(
      `SELECT conname FROM pg_constraint WHERE conname = ANY($1)`,
      [expectedConstraints]
    );
    const migrated = new Set(pkRows.map((r) => r.conname));
    for (const table of COMPOSITE_PK_TABLES) {
      const conname = `${table}_pk_company`;
      console.log(`  ${table}: ${migrated.has(conname) ? "복합 PK 전환 완료" : "아직 아님(다음 서버 재기동 시 자동 재시도됨)"}`);
    }
    if (migrated.size === COMPOSITE_PK_TABLES.length) {
      console.log("\n모든 테이블이 복합 PK로 전환되었습니다 — 이제 새 server.js를 배포/재기동해도 안전합니다.");
    } else {
      console.log("\n⚠ 아직 전환되지 않은 테이블이 있습니다. 위 로그(NOTICE)에서 원인을 확인하세요 —");
      console.log("  보통은 이 스크립트가 미처 모르는 다른 테이블에 아직 company_id NULL 행이 남아있는 경우입니다.");
    }
  } else {
    console.log("\n⚠ 아직 company_id가 NULL인 행이 남아있습니다 — 원인을 확인하세요.");
    console.log("  복합 PK 전환 대상 테이블들은 이 NULL이 전부 사라지기 전까지 전환이 보류됩니다.");
  }

  await pool.end();
}

main().catch((e) => {
  console.error("\n백필 실패:", e);
  process.exit(1);
});
