"use strict";

// 2026-09-01 감사에서 발견: 계정과목/거래처 마스터데이터(POST /api/accounting/accounts,
// POST /api/accounting/partners)는 admin이 폼 전체를 다시 제출하는 방식인데, 두 admin이
// 같은 레코드를 거의 동시에 열어 서로 다른 필드를 고치면 CAS 검증이 전혀 없어 나중 저장이
// 먼저 저장을 통째로 덮어썼다(실측 재현: 순차 요청 2건에서 B의 저장이 A의 변경을 조용히
// 삭제, 200으로 성공). PMS 프로젝트 수정(POST /api/pms/projects/:id)이 이미 쓰는
// `expectedUpdatedAt` 옵트인 CAS 패턴을 그대로 적용해 고쳤다 — 이 파일은 그 보호를
// 검증한다. JSON 파일 모드는 순차 시나리오(단일 스레드라 진짜 동시성 재현은 의미가 없음),
// Postgres 모드는 실제 동시 요청 20개로 원자성(UPDATE...WHERE 기반 CAS, SELECT 시점의
// TOCTOU가 아님)까지 검증한다.
const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer, bootstrapAdminAndLogin } = require("./support/start-server");

function auth(token, method, body) {
  return {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  };
}

test("계정과목/거래처 CAS(expectedUpdatedAt) — JSON 파일 모드", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const api = (path, options) => fetch(server.baseUrl + path, options);
  const boot = await bootstrapAdminAndLogin(server, { loginId: "admin1", pw: "admin1-test-pw", name: "관리자1" });
  const token = boot.token;

  await t.test("계정과목: expectedUpdatedAt이 옛 값이면 409, 새 레코드에는 updatedAt이 부여된다", async () => {
    const created = await (await api("/api/accounting/accounts", auth(token, "POST", { code: "T900", name: "원본", type: "expense", user: "admin1" }))).json();
    assert.equal(created.ok, true);
    assert.ok(created.account.updatedAt, "신규 생성 시 updatedAt이 없음");
    const staleAt = created.account.updatedAt;

    const editorA = await (await api("/api/accounting/accounts", auth(token, "POST", {
      id: created.account.id, code: "T900", name: "A가 수정", type: "expense", expectedUpdatedAt: staleAt, user: "adminA",
    }))).json();
    assert.equal(editorA.ok, true);
    assert.notEqual(editorA.account.updatedAt, staleAt, "수정 후 updatedAt이 갱신되지 않음");

    const editorB = await api("/api/accounting/accounts", auth(token, "POST", {
      id: created.account.id, code: "T900", name: "B가 수정(stale)", type: "expense", expectedUpdatedAt: staleAt, user: "adminB",
    }));
    assert.equal(editorB.status, 409);
    const body = await editorB.json();
    assert.equal(body.code, "ACCT_ACCOUNT_CONFLICT");
    assert.equal(body.account.name, "A가 수정", "충돌 응답이 최신 서버 상태를 담고 있지 않음");

    const final = await (await api("/api/accounting/accounts", auth(token, "GET"))).json();
    assert.equal(final.accounts.find(a => a.id === created.account.id).name, "A가 수정", "B의 stale 저장이 A의 변경을 덮어씀");
  });

  await t.test("계정과목: expectedUpdatedAt을 안 보내면(구버전 클라이언트) 기존처럼 그냥 덮어쓴다", async () => {
    const created = await (await api("/api/accounting/accounts", auth(token, "POST", { code: "T901", name: "원본2", type: "expense", user: "admin1" }))).json();
    const r = await api("/api/accounting/accounts", auth(token, "POST", { id: created.account.id, code: "T901", name: "확인없이수정", type: "expense", user: "admin1" }));
    assert.equal(r.status, 200);
  });

  await t.test("거래처: expectedUpdatedAt이 옛 값이면 409, 최신 값이면 정상 반영된다", async () => {
    const created = await (await api("/api/accounting/partners", auth(token, "POST", { name: "원본거래처", type: "vendor", user: "admin1" }))).json();
    const staleAt = created.partner.updatedAt;
    assert.ok(staleAt);

    const stale = await api("/api/accounting/partners", auth(token, "POST", {
      id: created.partner.id, name: "stale수정", type: "vendor", expectedUpdatedAt: staleAt, user: "adminA",
    }));
    assert.equal(stale.status, 200, "첫 수정은 통과해야 함");
    const staleBody = await stale.json();

    const secondStale = await api("/api/accounting/partners", auth(token, "POST", {
      id: created.partner.id, name: "덮어쓰기시도", type: "vendor", expectedUpdatedAt: staleAt, user: "adminB",
    }));
    assert.equal(secondStale.status, 409);
    const conflictBody = await secondStale.json();
    assert.equal(conflictBody.code, "ACCT_PARTNER_CONFLICT");

    const freshOk = await api("/api/accounting/partners", auth(token, "POST", {
      id: created.partner.id, name: "최신값으로재시도", type: "vendor", expectedUpdatedAt: staleBody.partner.updatedAt, user: "adminB",
    }));
    assert.equal(freshOk.status, 200, "최신 updatedAt으로 재시도하면 정상 반영돼야 함");
  });
});

const ADMIN_DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!ADMIN_DATABASE_URL) {
  test("계정과목/거래처 CAS — Postgres 동시성 (skipped: DATABASE_URL/TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  const { Client } = require("pg");

  test("계정과목/거래처 CAS(expectedUpdatedAt) — 실제 PostgreSQL 동시 요청 원자성", async (t) => {
    const dbName = `hrtest_acctcas_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
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

    const reg = await (await api("/api/companies/register", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ companyName: "CAS동시성테스트", adminName: "관리자", loginId: "admin", password: "TestPassword123" }),
    })).json();
    assert.equal(reg.ok, true);
    const token = reg.token;

    await t.test("계정과목: 같은 stale expectedUpdatedAt으로 20개 동시 요청 → 정확히 1건만 성공", async () => {
      const created = await (await api("/api/accounting/accounts", auth(token, "POST", { code: "R100", name: "원본", type: "expense", user: "admin" }))).json();
      const staleAt = created.account.updatedAt;
      const statuses = await Promise.all(Array.from({ length: 20 }, (_, i) =>
        api("/api/accounting/accounts", auth(token, "POST", {
          id: created.account.id, code: "R100", name: `동시수정자${i}`, type: "expense", expectedUpdatedAt: staleAt, user: `racer${i}`,
        })).then(r => r.status)
      ));
      assert.equal(statuses.filter(s => s === 200).length, 1, "정확히 1건만 성공해야 함");
      assert.equal(statuses.filter(s => s === 409).length, 19, "나머지 19건은 전부 409여야 함");
    });

    await t.test("거래처: 같은 stale expectedUpdatedAt으로 20개 동시 요청 → 정확히 1건만 성공", async () => {
      const created = await (await api("/api/accounting/partners", auth(token, "POST", { name: "원본거래처", type: "vendor", user: "admin" }))).json();
      const staleAt = created.partner.updatedAt;
      const statuses = await Promise.all(Array.from({ length: 20 }, (_, i) =>
        api("/api/accounting/partners", auth(token, "POST", {
          id: created.partner.id, name: `동시수정자${i}`, type: "vendor", expectedUpdatedAt: staleAt, user: `racer${i}`,
        })).then(r => r.status)
      ));
      assert.equal(statuses.filter(s => s === 200).length, 1, "정확히 1건만 성공해야 함");
      assert.equal(statuses.filter(s => s === 409).length, 19, "나머지 19건은 전부 409여야 함");
    });
  });
}
