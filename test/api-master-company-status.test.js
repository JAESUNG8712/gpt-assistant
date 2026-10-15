"use strict";

// 플랫폼 companies.status(trial/active/suspended) 전환 기능의 회귀 테스트. 지금까지
// 이 값은 회원가입 시 'trial'로 고정 기록되고 마스터 콘솔에 배지로 표시만 될 뿐,
// 바꿀 수 있는 API도 전혀 없었고(server.js에 UPDATE companies가 0건), 설령 값이
// 바뀌어도 로그인/API 접근에 아무 영향이 없었다 — 이번에 PUT /master/companies/:id/status
// 신설 + 로그인/매요청 enforcement를 함께 추가했다. company_features와 마찬가지로
// companies.status는 Postgres 전용 멀티테넌트 SaaS 개념이라 JSON 파일 모드에서는
// 애초에 의미가 없다(test/api-company-feature-toggles.test.js와 동일한 전제).
const test = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { Client } = require("pg");
const { startServer } = require("./support/start-server");

const ADMIN_DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

if (!ADMIN_DATABASE_URL) {
  test("플랫폼 companies.status 전환 (skipped: DATABASE_URL/TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  test("companies.status 전환 API + 로그인/매요청 enforcement", async (t) => {
    const dbName = `hrtest_companystatus_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
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

    const server = await startServer({ env: { DATABASE_URL: testDbUrl } });
    t.after(() => server.stop());
    const api = (path, options) => fetch(server.baseUrl + path, options);

    // 마스터 계정 시딩(test/api-company-feature-toggles.test.js와 동일한 패턴).
    const db = new Client({ connectionString: testDbUrl });
    db.on("error", () => {});
    await db.connect();
    const masterPwHash = await bcrypt.hash("master-test-pw-12345", 10);
    await db.query(
      `INSERT INTO platform_admins (login_id, pw_hash, name) VALUES ($1,$2,$3)`,
      ["master_test_status", masterPwHash, "테스트 마스터"]
    );
    await db.end();

    async function registerCompany(name, loginId, password) {
      const r = await (await api("/api/companies/register", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyName: name, adminName: "관리자", loginId, password }),
      })).json();
      assert.equal(r.ok, true, `회사 가입 실패: ${JSON.stringify(r)}`);
      return r;
    }
    const compA = await registerCompany("상태전환A", "status_admin_a", "TestPassword123");
    const compB = await registerCompany("상태전환B", "status_admin_b", "TestPassword123");

    const masterLogin = await (await api("/master/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ loginId: "master_test_status", password: "master-test-pw-12345" }),
    })).json();
    assert.equal(masterLogin.ok, true);
    const hdrM = { Authorization: `Bearer ${masterLogin.token}` };

    async function setStatus(companyId, status, headers = hdrM) {
      return (await api(`/master/companies/${companyId}/status`, {
        method: "PUT", headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ status }),
      })).json();
    }

    await t.test("신규 가입 회사는 항상 trial로 시작한다", async () => {
      const list = await (await api("/master/companies", { headers: hdrM })).json();
      const a = list.companies.find(c => c.id === compA.company.id);
      assert.equal(a.status, "trial");
    });

    await t.test("마스터가 아닌 요청은 403", async () => {
      const r = await setStatus(compA.company.id, "active", { Authorization: `Bearer ${compA.token}` });
      assert.equal(r.ok, false);
    });

    await t.test("잘못된 status 값은 400", async () => {
      const r = await setStatus(compA.company.id, "deleted");
      assert.equal(r.ok, false);
    });

    await t.test("존재하지 않는 회사 id는 404(500 아님)", async () => {
      const res = await api(`/master/companies/00000000-0000-0000-0000-000000000000/status`, {
        method: "PUT", headers: { "Content-Type": "application/json", ...hdrM },
        body: JSON.stringify({ status: "active" }),
      });
      assert.equal(res.status, 404);
    });

    await t.test("정상 전환(trial→active)이 적용되고 master_audit_log에 from/to가 기록된다", async () => {
      const r = await setStatus(compA.company.id, "active");
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(r.company.status, "active");

      const check = new Client({ connectionString: testDbUrl });
      check.on("error", () => {});
      await check.connect();
      try {
        const { rows } = await check.query(
          "SELECT detail FROM master_audit_log WHERE action = 'status_change' AND company_id = $1 ORDER BY created_at DESC LIMIT 1",
          [compA.company.id]
        );
        assert.equal(rows.length, 1);
        assert.deepEqual(rows[0].detail, { from: "trial", to: "active" });
      } finally {
        await check.end();
      }
    });

    // /events(SSE)의 쿼리스트링 티켓(scope:"sse")은 전역 authenticate() 미들웨어를 완전히
    // 비껴가(EventSource가 커스텀 헤더를 못 붙여 Authorization 대신 ?token=으로 전달) 이
    // 라우트가 세션 철회만 직접 재구현하고 companyStatus는 재확인하지 않던 틈이 있었다
    // (작업6 재점검에서 발견·수정) — 티켓은 정지 "전"에 발급받아둬야 재현 가능하므로
    // 여기서 먼저 발급한다.
    let compASseTicket;
    await t.test("회사 A가 정지되기 전 SSE 티켓을 발급받아둔다", async () => {
      const r = await (await api("/events/token", {
        method: "POST", headers: { Authorization: `Bearer ${compA.token}` },
      })).json();
      assert.equal(r.ok, true, JSON.stringify(r));
      compASseTicket = r.token;
    });

    await t.test("정지(suspended) 전환 후: 그 회사는 로그인 자체가 차단된다(자격증명은 맞음)", async () => {
      const r = await setStatus(compA.company.id, "suspended");
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(r.company.status, "suspended");

      const login = await (await api("/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyCode: compA.company.slug, loginId: "status_admin_a", pw: "TestPassword123" }),
      })).json();
      assert.equal(login.ok, false);
      assert.equal(login.code, "COMPANY_SUSPENDED");
      assert.ok(!login.token, "정지된 회사는 새 토큰을 발급받으면 안 됨");
    });

    await t.test("정지 전에 이미 발급된 토큰도 다음 요청부터 즉시 차단된다(세션 즉시 무효화)", async () => {
      const res = await api("/status", { headers: { Authorization: `Bearer ${compA.token}` } });
      const body = await res.json();
      assert.equal(res.status, 403);
      assert.equal(body.code, "COMPANY_SUSPENDED");
    });

    await t.test("정지 전 발급된 SSE 티켓도 /events에서 즉시 차단된다(세션철회 재구현에만 있던 틈 수정)", async () => {
      // 403 분기는 res.flushHeaders()/스트리밍 쓰기 전에 즉시 반환되므로 평범한 JSON
      // 응답과 동일하게 받을 수 있다. 반면 이 검사가 없던 수정 전 코드는 티켓을 그대로
      // 통과시켜 res.flushHeaders() 이후 text/event-stream을 계속 쓰기만 해(res.json()이
      // 영원히 끝나지 않음) — AbortController로 그 경우를 "통과 못함(타임아웃)"으로
      // 확실히 실패시킨다(무한 행 방지 + 회귀 시 멈춰있지 않고 바로 알 수 있게).
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 5000);
      try {
        const res = await api(`/events?token=${encodeURIComponent(compASseTicket)}`, { signal: ac.signal });
        const body = await res.json();
        assert.equal(res.status, 403);
        assert.equal(body.code, "COMPANY_SUSPENDED");
      } finally {
        clearTimeout(timer);
      }
    });

    await t.test("다른 회사(B)는 A의 정지와 무관하게 정상 동작한다", async () => {
      const login = await (await api("/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyCode: compB.company.slug, loginId: "status_admin_b", pw: "TestPassword123" }),
      })).json();
      assert.equal(login.ok, true, JSON.stringify(login));
      assert.ok(login.token);

      const res = await api("/status", { headers: { Authorization: `Bearer ${compB.token}` } });
      assert.equal(res.status, 200);
    });

    await t.test("impersonation 토큰은 정지된 회사에도 예외적으로 접근할 수 있다(마스터가 되돌리기 위해)", async () => {
      const imp = await (await api(`/master/companies/${compA.company.id}/impersonate`, {
        method: "POST", headers: hdrM,
      })).json();
      assert.equal(imp.ok, true, JSON.stringify(imp));
      const res = await api("/status", { headers: { Authorization: `Bearer ${imp.token}` } });
      assert.equal(res.status, 200, "impersonation 토큰은 companies.status 차단에서 예외여야 함");
    });

    await t.test("다시 active로 되돌리면 즉시 복구된다", async () => {
      const r = await setStatus(compA.company.id, "active");
      assert.equal(r.ok, true);
      const res = await api("/status", { headers: { Authorization: `Bearer ${compA.token}` } });
      assert.equal(res.status, 200, "active로 복구된 뒤에는 기존 토큰이 다시 정상 동작해야 함");
    });
  });
}
