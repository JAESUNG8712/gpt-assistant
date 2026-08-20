// server.js를 PostgreSQL 모드(DATABASE_URL 설정)로 별도 프로세스에 띄워 멀티테넌트
// 핵심 흐름(회사 가입/로그인/격리)을 검증한다. 운영 DB는 절대 쓰지 않는다 — 이
// 테스트는 매 실행마다 임의 이름의 새 데이터베이스를 만들어서만 쓰고 끝나면 지운다.
//
// DATABASE_URL(또는 TEST_DATABASE_URL)이 없으면(로컬에 Postgres가 없는 개발자 등)
// 이 파일 전체를 건너뛴다 — file-mode.test.js만으로도 핵심 API 계약은 커버되므로
// Postgres 미설치가 전체 테스트 스위트를 막지 않게 하기 위함. CI는
// services: postgres로 이 환경변수를 채워 넣는다(.github/workflows 참고).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");
const { startServer, startServerExpectingBootFailure } = require("../support/start-server");

const ADMIN_DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

if (!ADMIN_DATABASE_URL) {
  test("postgres-mode API suite (skipped: DATABASE_URL/TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  test("postgres-mode API suite", async (t) => {
    const dbName = `hrtest_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
    const testDbUrl = _withDatabaseName(ADMIN_DATABASE_URL, dbName);

    const admin = new Client({ connectionString: ADMIN_DATABASE_URL });
    await admin.connect();
    // 식별자는 사용자 입력이 아니라 이 파일이 스스로 만든 타임스탬프+난수 이름이라
    // 안전하게 그대로 SQL에 붙여넣을 수 있다(외부 입력 없음).
    await admin.query(`CREATE DATABASE ${dbName}`);

    t.after(async () => {
      try {
        // 테스트 서버들을 stop()에서 이미 종료했지만, 혹시 남은 커넥션이 있으면
        // DROP DATABASE가 "다른 세션이 사용 중"으로 실패할 수 있어 먼저 강제 종료한다.
        await admin.query(
          "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
          [dbName]
        );
        await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
      } finally {
        await admin.end();
      }
    });

    let serverA; // 공용 서버 인스턴스(schema.sql은 서버 부팅 시 자동 적용됨)
    t.after(async () => { if (serverA) await serverA.stop(); });
    serverA = await startServer({ env: { DATABASE_URL: testDbUrl } });
    const api = (p, opts) => fetch(serverA.baseUrl + p, opts);

    let companyACode, companyAToken;

    await t.test("1) POST /api/companies/register — 회사 가입 성공", async () => {
      const res = await api("/api/companies/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyName: "테스트회사A", adminName: "관리자A", loginId: "admin_a", password: "TestPassword123" }),
      });
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.ok, true);
      assert.ok(json.companyCode);
      assert.ok(json.token);
      assert.equal(json.employee.pw, undefined);
      assert.equal(json.employee.loginId, "admin_a");
      companyACode = json.companyCode;
      companyAToken = json.token;
    });

    await t.test("2) 반환된 companyCode로 로그인 성공", async () => {
      const res = await api("/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyCode: companyACode, loginId: "admin_a", pw: "TestPassword123" }),
      });
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.ok, true);
      assert.ok(json.token);
    });

    await t.test("3) Postgres 모드에서 companyCode 누락 시 400", async () => {
      const res = await api("/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ loginId: "admin_a", pw: "TestPassword123" }),
      });
      assert.equal(res.status, 400);
      const json = await res.json();
      assert.equal(json.ok, false);
    });

    await t.test("4) 회사별 token으로 GET /data — 본인 회사 데이터만 반환", async () => {
      const res = await api("/data", { headers: { Authorization: `Bearer ${companyAToken}` } });
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.ok, true);
      assert.equal(json.data.employees.length, 1);
      assert.equal(json.data.employees[0].loginId, "admin_a");
    });

    let companyBToken;
    await t.test("5) 두 번째 회사 가입 — 다른 companyCode 자동 배정", async () => {
      const res = await api("/api/companies/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyName: "테스트회사B", adminName: "관리자B", loginId: "admin_b", password: "TestPassword456" }),
      });
      const json = await res.json();
      assert.equal(json.ok, true);
      assert.notEqual(json.companyCode, companyACode);
      companyBToken = json.token;
    });

    await t.test("6) 회사 간 데이터 격리 — B 토큰으로는 A의 직원이 보이지 않음", async () => {
      const res = await api("/data", { headers: { Authorization: `Bearer ${companyBToken}` } });
      const json = await res.json();
      assert.equal(json.ok, true);
      assert.equal(json.data.employees.length, 1);
      assert.equal(json.data.employees[0].loginId, "admin_b");
      assert.ok(!json.data.employees.some(e => e.loginId === "admin_a"), "회사 B의 응답에 회사 A 직원이 섞이면 안 됨");
    });

    await t.test("7) 회사 간 데이터 격리 — B가 A의 companyCode로 admin_a 계정 로그인 시도는 실패", async () => {
      const res = await api("/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyCode: companyACode, loginId: "admin_b", pw: "TestPassword456" }),
      });
      const json = await res.json();
      assert.equal(json.ok, false, "회사 B 계정으로 회사 A의 companyCode를 대며 로그인하면 안 됨");
    });
  });

  // rejectDemoDataForProduction()의 부팅 시점(initDB()) 검사는 처음엔 JSON 파일 모드
  // 분기에만 있었고 Postgres 분기에는 없었다 — 그런데 실제 운영 배포는 정확히 이 Postgres
  // 분기를 타므로, 그 보호가 진짜 서비스에는 전혀 적용되지 않는 사각지대였다(발견 즉시
  // Postgres 분기에도 동일하게 배선). employees/kpi_entries 테이블에 더미 마커가 있는
  // 상태로 DB가 시작되면(예: 개발 DB를 실수로 운영에 연결) production 부팅이 fail-fast
  // 해야 한다는 것을 실제 DB에 직접 행을 심어 검증한다.
  test("postgres-mode: 부팅 시점 fail-fast(DB에 이미 더미 마커가 있는 상태에서 production 부팅)", async (t) => {
    const admin = new Client({ connectionString: ADMIN_DATABASE_URL });
    await admin.connect();
    t.after(() => admin.end());

    async function withFreshDb(fn) {
      const dbName = `hrtest_bootfail_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
      const dbUrl = _withDatabaseName(ADMIN_DATABASE_URL, dbName);
      await admin.query(`CREATE DATABASE ${dbName}`);
      try {
        await fn(dbUrl, dbName);
      } finally {
        await admin.query(
          "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
          [dbName]
        );
        await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
      }
    }

    // schema.sql을 미리 적용하고(회사/직원을 직접 INSERT하려면 스키마가 있어야 함) 데모
    // 마커가 섞인 행을 심은 뒤, 그 DB를 가리키는 production 서버가 부팅을 거부하는지 확인.
    async function seedDemoDataAndExpectBootFailure(seedFn) {
      await withFreshDb(async (dbUrl, dbName) => {
        const db = new Client({ connectionString: dbUrl });
        await db.connect();
        const schema = require("fs").readFileSync(require("path").join(__dirname, "..", "..", "schema.sql"), "utf8");
        await db.query(schema);
        await db.query(
          "INSERT INTO companies (id, slug, name, status) VALUES ('11111111-1111-1111-1111-111111111111', $1, 'QA Test Co', 'active')",
          [dbName]
        );
        await seedFn(db);
        await db.end();

        const result = await startServerExpectingBootFailure({ env: { NODE_ENV: "production", DATABASE_URL: dbUrl } });
        assert.notEqual(result.exitCode, 0, "더미 마커가 있는 DB로 production 부팅은 실패해야 함");
        assert.match(result.logs.stderr + result.logs.stdout, /더미 데이터/);
        result.cleanup();
      });
    }

    await t.test("source:\"demo\" 직원이 이미 DB에 있으면 부팅이 실패한다", async () => {
      await seedDemoDataAndExpectBootFailure(async (db) => {
        await db.query(
          "INSERT INTO employees (id, data, company_id) VALUES ('e1', $1::jsonb, '11111111-1111-1111-1111-111111111111')",
          [JSON.stringify({ id: "e1", loginId: "admin", name: "관리자", role: "admin", active: true })]
        );
        await db.query(
          "INSERT INTO employees (id, data, company_id) VALUES ('e2', $1::jsonb, '11111111-1111-1111-1111-111111111111')",
          [JSON.stringify({ id: "e2", loginId: "demo1", name: "데모직원", role: "member", active: true, source: "demo", empNo: "DEMO-0002" })]
        );
      });
    });

    await t.test("레거시 DM 패턴 empNo가 이미 DB에 있으면 부팅이 실패한다", async () => {
      await seedDemoDataAndExpectBootFailure(async (db) => {
        await db.query(
          "INSERT INTO employees (id, data, company_id) VALUES ('e1', $1::jsonb, '11111111-1111-1111-1111-111111111111')",
          [JSON.stringify({ id: "e1", loginId: "admin", name: "관리자", role: "admin", active: true })]
        );
        await db.query(
          "INSERT INTO employees (id, data, company_id) VALUES ('e3', $1::jsonb, '11111111-1111-1111-1111-111111111111')",
          [JSON.stringify({ id: "e3", loginId: "dummy1", name: "홍길동", role: "member", active: true, empNo: "DM경인001" })]
        );
      });
    });

    await t.test("KPI만 더미인 경우도 부팅이 실패한다", async () => {
      await seedDemoDataAndExpectBootFailure(async (db) => {
        await db.query(
          "INSERT INTO employees (id, data, company_id) VALUES ('e1', $1::jsonb, '11111111-1111-1111-1111-111111111111')",
          [JSON.stringify({ id: "e1", loginId: "admin", name: "관리자", role: "admin", active: true })]
        );
        await db.query(
          "INSERT INTO kpi_entries (id, employee_id, eval_year, data, company_id) VALUES ('k1', 'e1', 2025, $1::jsonb, '11111111-1111-1111-1111-111111111111')",
          [JSON.stringify({ id: "k1", source: "demo" })]
        );
      });
    });

    await t.test("더미 마커 없는 정상 데이터는 production에서도 정상 부팅된다(false positive 아님)", async () => {
      await withFreshDb(async (dbUrl, dbName) => {
        const db = new Client({ connectionString: dbUrl });
        await db.connect();
        const schema = require("fs").readFileSync(require("path").join(__dirname, "..", "..", "schema.sql"), "utf8");
        await db.query(schema);
        await db.query(
          "INSERT INTO companies (id, slug, name, status) VALUES ('11111111-1111-1111-1111-111111111111', $1, 'QA Test Co', 'active')",
          [dbName]
        );
        await db.query(
          "INSERT INTO employees (id, data, company_id) VALUES ('e1', $1::jsonb, '11111111-1111-1111-1111-111111111111')",
          [JSON.stringify({ id: "e1", loginId: "admin", name: "관리자", role: "admin", active: true })]
        );
        await db.end();

        const server = await startServer({ env: { NODE_ENV: "production", DATABASE_URL: dbUrl } });
        try {
          const res = await fetch(server.baseUrl + "/status");
          assert.equal(res.status, 200);
        } finally {
          await server.stop();
        }
      });
    });
  });
}

function _withDatabaseName(connStr, dbName) {
  const u = new URL(connStr);
  u.pathname = `/${dbName}`;
  return u.toString();
}
