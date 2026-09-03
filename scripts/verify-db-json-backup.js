"use strict";

// scripts/backup-db-json.js가 만든 JSON 백업을 설치 없이 검증한다.
// 실제 인사/급여/회계 row 내용은 출력하지 않고, 파일 무결성·필수 테이블·row 수만 확인한다.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const REQUIRED_TABLES = [
  "companies",
  "employees",
  "kpi_entries",
  "app_collections",
  "app_singletons",
  "accounts",
  "partners",
  "vouchers",
  "budget_store",
];

function _defaultBackupDir() {
  const base = process.env.BACKUP_DIR ||
    process.env.OneDrive ||
    process.env.OneDriveCommercial ||
    process.env.OneDriveConsumer ||
    path.join(os.homedir(), "OneDrive");
  return process.env.BACKUP_DIR ? base : path.join(base, "DB-Backups", "hr-system");
}

function _findLatestBackup() {
  const dir = _defaultBackupDir();
  if (!fs.existsSync(dir)) return null;
  const candidates = fs.readdirSync(dir)
    .filter(name => /^hrsystem-db-json-.+\.json$/i.test(name))
    .map(name => path.join(dir, name))
    .map(file => ({ file, mtime: fs.statSync(file).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return candidates[0]?.file || null;
}

function _readExpectedHash(checksumFile, backupFile) {
  if (!fs.existsSync(checksumFile)) return null;
  const text = fs.readFileSync(checksumFile, "utf8");
  const expectedName = path.basename(backupFile);
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [hash, ...rest] = trimmed.split(/\s+/);
    const filename = rest.join(" ");
    if (/^[a-f0-9]{64}$/i.test(hash) && (!filename || filename === expectedName)) return hash.toLowerCase();
  }
  return null;
}

function _rowCount(entry) {
  return Array.isArray(entry?.rows) ? entry.rows.length : null;
}

function main() {
  const backupFile = process.argv[2] || process.env.BACKUP_FILE || _findLatestBackup();
  if (!backupFile) {
    console.error("[verify-db-json-backup] 검증할 백업 파일을 찾지 못했습니다.");
    console.error("사용법: node scripts/verify-db-json-backup.js \"C:\\\\...\\\\hrsystem-db-json-....json\"");
    console.error("또는 BACKUP_DIR/BACKUP_FILE 환경변수를 지정하세요.");
    process.exit(1);
  }
  if (!fs.existsSync(backupFile)) {
    console.error(`[verify-db-json-backup] 파일이 없습니다: ${backupFile}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(backupFile);
  const actualHash = crypto.createHash("sha256").update(raw).digest("hex");
  const checksumFile = `${backupFile}.sha256`;
  const expectedHash = _readExpectedHash(checksumFile, backupFile);
  if (expectedHash && expectedHash !== actualHash) {
    console.error("[verify-db-json-backup] SHA256 불일치: 파일이 손상되었거나 다른 파일의 체크섬입니다.");
    console.error(`expected=${expectedHash}`);
    console.error(`actual=${actualHash}`);
    process.exit(1);
  }

  let backup;
  try {
    backup = JSON.parse(raw.toString("utf8"));
  } catch (err) {
    console.error(`[verify-db-json-backup] JSON 파싱 실패: ${err.message}`);
    process.exit(1);
  }

  const failures = [];
  const warnings = [];
  if (backup.type !== "hr-system-json-backup") failures.push("type이 hr-system-json-backup이 아닙니다.");
  if (!backup.exportedAt || Number.isNaN(Date.parse(backup.exportedAt))) failures.push("exportedAt이 없거나 날짜 형식이 아닙니다.");
  if (!backup.tables || typeof backup.tables !== "object") failures.push("tables 객체가 없습니다.");
  if (Array.isArray(backup.errors) && backup.errors.length) warnings.push(`백업 생성 중 기록된 오류 ${backup.errors.length}건이 있습니다.`);
  if (!expectedHash) warnings.push("SHA256 파일이 없거나 읽을 수 없어 체크섬 대조를 건너뛰었습니다.");

  const tables = backup.tables || {};
  for (const table of REQUIRED_TABLES) {
    const entry = tables[table];
    if (!entry) {
      failures.push(`필수 테이블 누락: ${table}`);
      continue;
    }
    if (entry.exists !== true) failures.push(`필수 테이블이 존재하지 않음: ${table}`);
    if (!Array.isArray(entry.rows)) failures.push(`필수 테이블 rows가 배열이 아님: ${table}`);
  }

  const tableNames = Object.keys(tables).sort();
  const summary = tableNames.map(table => ({
    table,
    exists: tables[table]?.exists === true,
    rows: _rowCount(tables[table]),
  }));
  const totalRows = summary.reduce((sum, item) => sum + (Number.isFinite(item.rows) ? item.rows : 0), 0);

  console.log(`[verify-db-json-backup] 파일: ${backupFile}`);
  console.log(`[verify-db-json-backup] exportedAt: ${backup.exportedAt || "(없음)"}`);
  console.log(`[verify-db-json-backup] source database: ${backup.source?.database || "(알 수 없음)"}`);
  console.log(`[verify-db-json-backup] 테이블: ${summary.length}개, 총 row: ${totalRows}건`);
  console.log(`[verify-db-json-backup] SHA256: ${actualHash}${expectedHash ? " (대조 성공)" : " (대조 없음)"}`);
  for (const item of summary) {
    console.log(`${item.table}: ${item.exists ? item.rows : "missing"} rows`);
  }

  if (warnings.length) {
    console.log("");
    for (const warning of warnings) console.warn(`[verify-db-json-backup] 경고: ${warning}`);
  }
  if (failures.length) {
    console.error("");
    for (const failure of failures) console.error(`[verify-db-json-backup] 실패: ${failure}`);
    process.exit(1);
  }

  console.log("");
  console.log("[verify-db-json-backup] 검증 통과: 백업 파일 구조와 필수 테이블이 정상입니다.");
}

main();
