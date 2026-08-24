"use strict";

// 코드 전수 검토 중 발견한 버그: budget.js의 26개 라우트가 readBudget()/updateBudget()
// 호출과 res.json() 응답 사이를 try/catch로 감싸지 않고 있었다. Express 4는 async 라우트
// 핸들러의 미처리 promise rejection을 자동으로 잡아 에러 응답으로 돌려주지 않는다 —
// server.js 최상단의 process.on('unhandledRejection', ...) 전역 안전망이 프로세스
// 크래시는 막아주지만, 그 특정 요청 자체는 클라이언트에 응답이 전혀 안 가는 채로
// 영원히 멈춘다(Postgres 순단 등 실제 DB 오류가 나면 재현됨 — 이 파일이 실제로
// budget_store 테이블을 지워 그 상황을 재현한다). 이 파일은 그 수정(try/catch 추가)이
// 실제로 "500을 즉시 응답하고 서버는 계속 살아있다"는 목적을 달성하는지 검증한다.
// 로컬 Postgres가 없으면(DATABASE_URL/TEST_DATABASE_URL 미설정) 전체를 건너뛴다 —
// file-mode 저장 경로(_readAllBudgetFile)는 내부적으로 모든 읽기 실패를 이미 삼키므로
// (손상 시 빈 데이터로 폴백) 이 버그가 재현되지 않기 때문에 Postgres 모드가 필요하다.
const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");
const { startServer } = require("./support/start-server");

const ADMIN_DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

if (!ADMIN_DATABASE_URL) {
  test("budget.js DB 오류 시 hang 방지(skipped: DATABASE_URL/TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  test("budget.js 라우트가 DB 오류 시 즉시 500을 반환하고 서버는 계속 응답한다(hang 방지)", async (t) => {
    const dbName = `hrtest_budgethang_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
    const base = ADMIN_DATABASE_URL.replace(/\/[^/]*(\?.*)?$/, "");
    const testDbUrl = `${base}/${dbName}`;

    const admin = new Client({ connectionString: ADMIN_DATABASE_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    t.after(async () => {
      try {
        await admin.query(
          "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
          [dbName]
        );
        await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
      } finally {
        await admin.end();
      }
    });

    const server = await startServer({ env: { DATABASE_URL: testDbUrl } }); // schema.sql 자동 적용
    t.after(() => server.stop());
    const api = (path, options) => fetch(server.baseUrl + path, options);

    const reg = await (await api("/api/companies/register", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ companyName: "예산DB오류테스트", adminName: "관리자", loginId: "admin", password: "TestPassword123" }),
    })).json();
    assert.equal(reg.ok, true);
    const hdr = { Authorization: `Bearer ${reg.token}` };

    // budget_store 테이블을 지워(rename) readBudget()의 SELECT가 실제로 던지도록 만든다.
    const dbClient = new Client({ connectionString: testDbUrl });
    await dbClient.connect();
    await dbClient.query("ALTER TABLE budget_store RENAME TO budget_store_broken");
    await dbClient.end();

    await t.test("GET /api/budget/data — DB 오류를 즉시 500으로 응답한다(hang 없음)", async () => {
      const t0 = Date.now();
      const r = await api("/api/budget/data", { headers: hdr, signal: AbortSignal.timeout(5000) });
      const elapsed = Date.now() - t0;
      assert.equal(r.status, 500);
      assert.ok(elapsed < 3000, `500 응답이 3초 안에 와야 함(실제 ${elapsed}ms) — hang이 재발하면 5초 타임아웃으로 요청 자체가 실패한다`);
    });

    await t.test("서버는 그 오류와 무관하게 계속 살아있고 다른 요청도 정상 처리한다", async () => {
      const r = await api("/status");
      assert.equal(r.status, 200);
    });
  });
}
