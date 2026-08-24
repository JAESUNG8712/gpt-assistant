// budget.js의 parseSheetIsolated()(예산 엑셀 업로드 5개 라우트가 실제로 쓰는 워커 스레드
// 격리 래퍼) 회귀 테스트 — lib/parse-sheet.js의 순수 파싱 로직 자체는
// test/api-parse-sheet.test.js가 커버하고, 이 파일은 그 로직을 실제 HTTP 업로드→워커
// 스레드→메인 스레드 relay 배선이 올바르게 동작하는지 검증한다.
//
// xlsx@0.18.5의 ReDoS 취약점(GHSA-5pgg-2g8v-p4x9)이 실제로 트리거되면(이 서버는 여러
// 회사가 하나의 Node 프로세스를 공유하는 멀티테넌트 구조) 메인 이벤트 루프가 멈춰
// 전체 서비스가 함께 정지할 수 있어, 파싱을 워커 스레드로 격리하고 타임아웃을 뒀다. 이
// 완화책이 실제로 "그 요청만 실패하고 서버 전체는 계속 살아있다"는 목적을 달성하는지가
// 이 테스트의 핵심 관심사다 — 진짜 ReDoS 페이로드 없이도 PARSE_SHEET_TIMEOUT_MS를
// 인위적으로 아주 짧게(1ms) 줘서 타임아웃 경로를 결정적으로 재현한다(어떤 파일이든
// 워커 스레드 기동+xlsx 모듈 최초 로드만으로도 1ms는 넘는다).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const xlsx = require("xlsx");
const { startServer, bootstrapAdminAndLogin } = require("./support/start-server");

function buildHeadcountXlsxBuffer() {
  const wb = xlsx.utils.book_new();
  const ws = xlsx.utils.aoa_to_sheet([["구분", "1월"], ["개발본부", 42]]);
  xlsx.utils.book_append_sheet(wb, ws, "Sheet1");
  return xlsx.write(wb, { type: "buffer", bookType: "xlsx" });
}

function multipartBody(fileBuffer, filename, mimeType) {
  const boundary = "----testboundary" + Math.random().toString(16).slice(2);
  const pre = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`
  );
  const post = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { body: Buffer.concat([pre, fileBuffer, post]), contentType: `multipart/form-data; boundary=${boundary}` };
}

test("parseSheetIsolated() 배선 — 정상 업로드는 워커 스레드를 거쳐 그대로 반영된다", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const api = (path, options) => fetch(server.baseUrl + path, options);

  const boot = await bootstrapAdminAndLogin(server, { loginId: "admin", pw: "admin-test-pw-1", name: "관리자" });
  const adminToken = boot.token;

  const { body, contentType } = multipartBody(buildHeadcountXlsxBuffer(), "headcount.xlsx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  const r = await api("/api/budget/upload/headcount", {
    method: "POST", headers: { "Content-Type": contentType, Authorization: `Bearer ${adminToken}` }, body,
  });
  assert.equal(r.status, 200);
  const json = await r.json();
  assert.equal(json.upserted, 1);
  assert.deepEqual(json.depts, ["개발본부"]);
});

test("parseSheetIsolated() 배선 — 손상된 파일은 워커에서 던진 에러가 그대로 400으로 relay된다", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const api = (path, options) => fetch(server.baseUrl + path, options);

  const boot = await bootstrapAdminAndLogin(server, { loginId: "admin", pw: "admin-test-pw-2", name: "관리자" });
  const adminToken = boot.token;

  // xlsx는 알 수 없는 내용을 만나면(예: 평문 텍스트) 실제로 던지지 않고 그 내용을 통째로
  // 셀 하나짜리 시트로 관대하게 받아들인다(실측 확인) — 진짜로 파싱 예외를 재현하려면
  // ZIP 매직바이트(PK\x03\x04)는 있지만 실제 ZIP 구조가 깨진 버퍼가 필요하다.
  const brokenZip = Buffer.from("PK\x03\x04" + "not-a-real-zip-structure-".repeat(5));
  const { body, contentType } = multipartBody(brokenZip, "broken.xlsx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  const r = await api("/api/budget/upload/headcount", {
    method: "POST", headers: { "Content-Type": contentType, Authorization: `Bearer ${adminToken}` }, body,
  });
  assert.equal(r.status, 400);
  const json = await r.json();
  assert.match(json.error, /읽을 수 없습니다/);
});

test("parseSheetIsolated() 배선 — 타임아웃이 걸린 워커만 종료되고, 메인 서버는 계속 살아있다(핵심 완화 목표)", async (t) => {
  // 실제 ReDoS 페이로드 없이 PARSE_SHEET_TIMEOUT_MS를 극단적으로 짧게(1ms) 줘서 타임아웃
  // 경로를 결정적으로 재현한다 — 워커 스레드 기동+xlsx 최초 require만으로도 1ms는 넘는다.
  const server = await startServer({ env: { PARSE_SHEET_TIMEOUT_MS: "1" } });
  t.after(() => server.stop());
  const api = (path, options) => fetch(server.baseUrl + path, options);

  const boot = await bootstrapAdminAndLogin(server, { loginId: "admin", pw: "admin-test-pw-3", name: "관리자" });
  const adminToken = boot.token;

  const { body, contentType } = multipartBody(buildHeadcountXlsxBuffer(), "headcount.xlsx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  const r = await api("/api/budget/upload/headcount", {
    method: "POST", headers: { "Content-Type": contentType, Authorization: `Bearer ${adminToken}` }, body,
  });
  assert.equal(r.status, 400);
  const json = await r.json();
  assert.match(json.error, /시간이 초과/);

  // 타임아웃으로 워커 하나가 강제 종료된 직후에도, 메인 서버(이벤트 루프)는 계속 정상
  // 응답한다는 것을 바로 이어서 확인 — 이게 이 격리 완화책의 존재 이유다.
  const status = await api("/status");
  assert.equal(status.status, 200);
  const loginRetry = await (await api("/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ loginId: "admin", pw: "admin-test-pw-3" }),
  })).json();
  assert.equal(loginRetry.ok, true);
});
