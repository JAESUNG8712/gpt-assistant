// 멀티테넌트 전환 1단계: 기존(단일 회사) Postgres 데이터에 company_id를 백필한다.
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
// Usage:
//   DATABASE_URL=postgres://... COMPANY_NAME="회사명" COMPANY_SLUG="company-slug" \
//     node scripts/migrate-add-company-id.js
//
//   COMPANY_SLUG 생략 시 COMPANY_NAME에서 자동 생성한다.
"use strict";
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL이 설정되어 있지 않습니다. 예: DATABASE_URL=postgres://... COMPANY_NAME=\"회사명\" node scripts/migrate-add-company-id.js");
  process.exit(1);
}
if (!process.env.COMPANY_NAME) {
  console.error("COMPANY_NAME이 설정되어 있지 않습니다. 기존 데이터가 소속될 회사 이름을 지정하세요.");
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

// 백필 대상: company_id 컬럼이 nullable로 추가된 4개 테이블(1단계 범위).
// 나머지 모듈(app_collections/accounting/erp/pms/recruit 등)은 후속 단계에서
// company_id 컬럼 추가와 함께 각자 다룬다 — 이 스크립트의 범위 밖.
const TABLES = ["employees", "kpi_entries", "employee_history", "kpi_history"];

async function main() {
  console.log(`회사 백필 시작 (DATABASE_URL 대상)`);
  const schema = fs.readFileSync(path.join(__dirname, "..", "schema.sql"), "utf8");
  await pool.query(schema);
  console.log("스키마 확인/생성 완료.");

  const slug = process.env.COMPANY_SLUG || slugify(process.env.COMPANY_NAME);
  let companyId;
  const existing = await pool.query("SELECT id FROM companies WHERE slug = $1", [slug]);
  if (existing.rows.length) {
    companyId = existing.rows[0].id;
    console.log(`기존 회사 재사용: slug="${slug}" id=${companyId}`);
  } else {
    const { rows } = await pool.query(
      "INSERT INTO companies (slug, name, status) VALUES ($1,$2,'active') RETURNING id",
      [slug, process.env.COMPANY_NAME]
    );
    companyId = rows[0].id;
    console.log(`신규 회사 생성: slug="${slug}" name="${process.env.COMPANY_NAME}" id=${companyId}`);
  }

  for (const table of TABLES) {
    const before = await pool.query(`SELECT COUNT(*) FROM ${table} WHERE company_id IS NULL`);
    const { rowCount } = await pool.query(
      `UPDATE ${table} SET company_id = $1 WHERE company_id IS NULL`,
      [companyId]
    );
    console.log(`  ${table}: ${rowCount}건 백필 (백필 전 NULL ${before.rows[0].count}건)`);
  }

  console.log("\n백필 후 잔여 NULL 확인 (전부 0이어야 안전):");
  let allClear = true;
  for (const table of TABLES) {
    const { rows } = await pool.query(`SELECT COUNT(*) FROM ${table} WHERE company_id IS NULL`);
    const remaining = parseInt(rows[0].count, 10);
    if (remaining > 0) allClear = false;
    console.log(`  ${table}: NULL 잔여 ${remaining}건`);
  }

  if (allClear) {
    console.log("\n모든 대상 테이블의 company_id가 채워졌습니다.");
    console.log("NOT NULL 제약은 이 스크립트가 자동으로 걸지 않습니다 — 데이터를 눈으로");
    console.log("한 번 더 확인한 뒤, 별도로 다음을 실행해 제약을 걸어주세요:");
    for (const table of TABLES) {
      console.log(`  ALTER TABLE ${table} ALTER COLUMN company_id SET NOT NULL;`);
    }
  } else {
    console.log("\n⚠ 아직 company_id가 NULL인 행이 남아있습니다 — 원인을 확인하세요.");
  }

  await pool.end();
}

main().catch((e) => {
  console.error("\n백필 실패:", e);
  process.exit(1);
});
