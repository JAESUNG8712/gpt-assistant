"use strict";

// 마스터 관리자 콘솔에서 회사별로 모듈(회계/영업/재고/PMS/채용/사업계획 등)을 켜고 끄는
// 기능의 회귀 테스트. company_features 테이블 자체는 이미 있었지만(2026-08-21 이전
// 세션) isFeatureEnabled()가 실제로 아무 라우트에도 배선되지 않아 토글이 눈속임에
// 불과했다 — 이번에 requireFeature()를 REST 라우트(accounting/erp/pms/recruit/budget)에
// 실제로 배선했다. 이 파일은 그 배선이 실제로 동작하는지(끄면 403, 켜져 있으면 200,
// 회사 A를 꺼도 회사 B는 무관) 실제 PostgreSQL로 검증한다 — company_features는 Postgres
// 전용 개념(멀티테넌트 SaaS 모드)이라 JSON 파일 모드에서는 애초에 의미가 없다.
const test = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { Client } = require("pg");
const { startServer } = require("./support/start-server");

const ADMIN_DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

if (!ADMIN_DATABASE_URL) {
  test("회사별 모듈 on/off 토글 (skipped: DATABASE_URL/TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  test("회사별 모듈 on/off 토글이 실제로 REST API를 막고 여는지", async (t) => {
    const dbName = `hrtest_featuretoggle_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
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

    // 마스터 계정을 seed-master-admin.js와 동일한 방식(bcrypt 직접 INSERT)으로 시딩.
    const db = new Client({ connectionString: testDbUrl });
    // 이 연결은 시딩에만 쓰고 명시적으로 닫는다(t.after가 아니라 바로 아래에서) — DB
    // 정리 단계의 pg_terminate_backend가 아직 열려있는 이 연결을 강제로 끊으면 pg
    // 클라이언트가 처리되지 않은 'error' 이벤트를 던져 테스트 전체가 uncaughtException으로
    // 실패한다(실제로 재현됨). 항상 'error' 리스너를 붙여 방어하고, 시딩이 끝나는 즉시
    // 정상 종료해 그 시점 자체를 없앤다.
    db.on("error", () => {});
    await db.connect();
    const masterPwHash = await bcrypt.hash("master-test-pw-12345", 10);
    await db.query(
      `INSERT INTO platform_admins (login_id, pw_hash, name) VALUES ($1,$2,$3)`,
      ["master_test", masterPwHash, "테스트 마스터"]
    );
    await db.end();

    // 회사 A(토글 대상)와 B(대조군, 절대 건드리지 않음)를 각각 가입시켜 admin 토큰을 얻는다.
    async function registerCompany(name, loginId) {
      const r = await (await api("/api/companies/register", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyName: name, adminName: "관리자", loginId, password: "TestPassword123" }),
      })).json();
      assert.equal(r.ok, true, `회사 가입 실패: ${JSON.stringify(r)}`);
      return r;
    }
    const compA = await registerCompany("모듈토글A", "admin_a");
    const compB = await registerCompany("모듈토글B", "admin_b");
    const hdrA = { Authorization: `Bearer ${compA.token}` };
    const hdrB = { Authorization: `Bearer ${compB.token}` };

    const masterLogin = await (await api("/master/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ loginId: "master_test", password: "master-test-pw-12345" }),
    })).json();
    assert.equal(masterLogin.ok, true);
    const hdrM = { Authorization: `Bearer ${masterLogin.token}` };

    async function setFeature(companyId, key, enabled) {
      const r = await (await api(`/master/companies/${companyId}/features/${key}`, {
        method: "PUT", headers: { "Content-Type": "application/json", ...hdrM },
        body: JSON.stringify({ enabled }),
      })).json();
      assert.equal(r.ok, true, `feature 설정 실패(${key}=${enabled}): ${JSON.stringify(r)}`);
    }

    await t.test("GET /master/feature-catalog — 고정 목록을 반환한다(자유 텍스트 아님)", async () => {
      const r = await (await api("/master/feature-catalog", { headers: hdrM })).json();
      assert.equal(r.ok, true);
      assert.ok(r.catalog.some(f => f.key === "acct" && f.label === "회계"));
      assert.ok(r.catalog.length >= 13);
    });

    await t.test("PUT .../features/:key — 카탈로그에 없는 키는 400으로 거부(데이터 유효성)", async () => {
      const r = await (await api(`/master/companies/${compA.company.id}/features/made_up_key`, {
        method: "PUT", headers: { "Content-Type": "application/json", ...hdrM },
        body: JSON.stringify({ enabled: false }),
      })).json();
      assert.equal(r.ok, false);
    });

    const moduleRoutes = [
      { key: "acct", method: "GET", path: "/api/accounting/accounts" },
      { key: "pms", method: "GET", path: "/api/pms/projects" },
      { key: "recruit", method: "GET", path: "/api/recruit/jobs" },
      { key: "sales", method: "GET", path: "/api/erp/quotations" },
      { key: "inventory", method: "GET", path: "/api/erp/purchase-requests" },
      { key: "bizplan", method: "GET", path: "/api/budget/business-plan" },
    ];

    for (const m of moduleRoutes) {
      await t.test(`${m.key} 모듈 — 기본은 활성(200), 끄면 403, 다시 켜면 200 복구`, async () => {
        const before = await api(m.path, { method: m.method, headers: hdrA });
        assert.equal(before.status, 200, `${m.key} 기본 활성 상태에서 200이어야 함`);

        await setFeature(compA.company.id, m.key, false);
        const off = await api(m.path, { method: m.method, headers: hdrA });
        assert.equal(off.status, 403, `${m.key}를 껐는데도 통과됨`);
        const offBody = await off.json();
        assert.equal(offBody.code, "FEATURE_DISABLED");

        await setFeature(compA.company.id, m.key, true);
        const on = await api(m.path, { method: m.method, headers: hdrA });
        assert.equal(on.status, 200, `${m.key}를 다시 켰는데 여전히 막힘`);
      });
    }

    await t.test("회사 A의 토글은 회사 B에 전혀 영향을 주지 않는다(멀티테넌트 격리)", async () => {
      await setFeature(compA.company.id, "acct", false);
      const bStillOn = await api("/api/accounting/accounts", { headers: hdrB });
      assert.equal(bStillOn.status, 200, "회사 A를 껐는데 회사 B까지 막히면 안 됨");
      await setFeature(compA.company.id, "acct", true);
    });

    await t.test("/api/erp/items·/api/erp/locations — inventory를 꺼도 계속 열려있음(구매요청 드롭다운 의존)", async () => {
      await setFeature(compA.company.id, "inventory", false);
      const items = await api("/api/erp/items", { headers: hdrA });
      assert.equal(items.status, 200);
      const locations = await api("/api/erp/locations", { headers: hdrA });
      assert.equal(locations.status, 200);
      await setFeature(compA.company.id, "inventory", true);
    });

    await t.test("budget.js 라우터 전체(업로드·개인별 급여상세 포함)가 bizplan 토글의 영향을 받는다", async () => {
      await setFeature(compA.company.id, "bizplan", false);
      const uploads = await api("/api/budget/uploads", { headers: hdrA });
      assert.equal(uploads.status, 403);
      await setFeature(compA.company.id, "bizplan", true);
      const uploadsOn = await api("/api/budget/uploads", { headers: hdrA });
      assert.equal(uploadsOn.status, 200);
    });

    // 2026-08-27 병행 세션 감사에서 발견: Express 라우팅은 기본적으로 대소문자를
    // 구분하지 않아 "/API/Accounting/Accounts" 같은 요청도 실제 핸들러까지 정상
    // 도달하는데, requireFeature 디스패처가 req.path를 원본 대소문자 그대로 문자열
    // 비교(.startsWith)해 대문자 경로는 featureKey를 못 찾고 조용히 next()로 넘어가 —
    // 회사가 명시적으로 끈 모듈("이 회사에서 절대 켜지지 않아야 함"이 이 기능의 존재
    // 이유)이 대소문자만 바꾸면 role/menuPerms와 무관하게 완전히 우회됐다(실측: 대문자
    // 경로로 조회는 물론 계정 생성 쓰기까지 성공, 실제 DB에 반영됨). 같은 시점에 별도
    // 세션이 더 근본적인 방어(전역 `case sensitive routing`+`_apiPathCaseMismatch`
    // 이른 단계 404 미들웨어)를 병행 추가해, 지금은 이 요청들이 requireFeature
    // 디스패처까지 가지도 못하고 그 전에 404로 끊긴다 — 대소문자 변형이 여러 방어선 중
    // 어느 하나로든 반드시 막히는지 확인한다(403 또는 404 둘 다 허용).
    await t.test("URL 대소문자를 바꿔도 회사 단위 모듈 킬스위치(requireFeature)를 우회할 수 없다 — 조회·쓰기 모두", async () => {
      await setFeature(compA.company.id, "acct", false);
      for (const path of ["/API/Accounting/Accounts", "/Api/accounting/Accounts", "/api/ACCOUNTING/accounts"]) {
        const r = await api(path, { headers: hdrA });
        assert.ok([403, 404].includes(r.status), `${path} 가 requireFeature 차단을 우회함(status=${r.status})`);
      }
      const writeAttempt = await api("/API/Accounting/Accounts", {
        method: "POST", headers: { "Content-Type": "application/json", ...hdrA },
        body: JSON.stringify({ code: "998", name: "우회생성계정", type: "asset" }),
      });
      assert.ok([403, 404].includes(writeAttempt.status), `대문자 경로로 계정 생성이 통과됨(status=${writeAttempt.status})`);
      await setFeature(compA.company.id, "acct", true);
      const list = await api("/api/accounting/accounts", { headers: hdrA });
      const accounts = (await list.json()).accounts || [];
      assert.equal(accounts.some(a => a.code === "998"), false, "대소문자 우회로 계정이 실제 DB에 생성됨");
    });
  });
}
