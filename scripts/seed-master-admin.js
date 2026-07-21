// 마스터 관리자(플랫폼 운영자) 계정을 out-of-band로 발급하는 일회성 스크립트.
//
// platform_admins는 employees와 완전히 분리된 테이블이고, 셀프서브 가입 엔드포인트가
// 의도적으로 없다(계획 문서 "마스터 관리자 + 회사별 기능 커스터마이징" 참고 — 마스터
// 계정은 항상 개발자/운영자가 직접 발급). 이 스크립트가 그 발급 경로다.
//
// Usage:
//   DATABASE_URL=postgres://... MASTER_LOGIN_ID=owner MASTER_PASSWORD=... MASTER_NAME="플랫폼 운영자" \
//     node scripts/seed-master-admin.js
//
// 이미 같은 login_id의 계정이 있으면 비밀번호/이름을 갱신한다(재실행 안전 — upsert).
"use strict";
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL이 설정되어 있지 않습니다.");
  process.exit(1);
}
if (!process.env.MASTER_LOGIN_ID || !process.env.MASTER_PASSWORD) {
  console.error("MASTER_LOGIN_ID, MASTER_PASSWORD가 필요합니다. 예:");
  console.error('  DATABASE_URL=postgres://... MASTER_LOGIN_ID=owner MASTER_PASSWORD=... MASTER_NAME="플랫폼 운영자" node scripts/seed-master-admin.js');
  process.exit(1);
}
if (String(process.env.MASTER_PASSWORD).length < 8) {
  console.error("MASTER_PASSWORD는 8자 이상이어야 합니다.");
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const schema = fs.readFileSync(path.join(__dirname, "..", "schema.sql"), "utf8");
  await pool.query(schema);
  console.log("스키마 확인/생성 완료.");

  const loginId = process.env.MASTER_LOGIN_ID;
  const name = process.env.MASTER_NAME || loginId;
  const pwHash = await bcrypt.hash(process.env.MASTER_PASSWORD, 10);

  const { rows } = await pool.query(
    `INSERT INTO platform_admins (login_id, pw_hash, name)
     VALUES ($1,$2,$3)
     ON CONFLICT (login_id) DO UPDATE SET pw_hash = $2, name = $3
     RETURNING id, login_id, name, created_at`,
    [loginId, pwHash, name]
  );
  console.log("마스터 관리자 계정 발급 완료:", rows[0]);
  await pool.end();
}

main().catch((e) => {
  console.error("실패:", e);
  process.exit(1);
});
