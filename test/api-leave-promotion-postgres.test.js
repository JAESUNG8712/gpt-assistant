// 연차 사용촉진 메일 발송 기록의 PostgreSQL 경로: 회사 설정 조회(app_singletons), 회사 단위 발송,
// leavePromotionNotices 저장이 실제 DB에서 맞물리는지 확인한다. TEST_DATABASE_URL/DATABASE_URL이 없으면 건너뜀.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");
const { startServer } = require("./support/start-server");
const { startMockSmtp } = require("./support/mock-smtp");

const ADMIN_DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const wait = ms => new Promise(r => setTimeout(r, ms));
const auth = (token, method, body) => ({
  method,
  headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: body !== undefined ? JSON.stringify(body) : undefined,
});

if (!ADMIN_DATABASE_URL) {
  test("연차 촉진 메일 PostgreSQL 경로 (skipped: DATABASE_URL/TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  test("연차 촉진 메일: 회사 설정을 켠 PG 회사에서 한 번만 발송되고 발송 기록이 DB에 저장된다", async t => {
    const dbName = `hrtest_leavepromo_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
    const base = ADMIN_DATABASE_URL.replace(/\/[^/]*(\?.*)?$/, "");
    const testDbUrl = `${base}/${dbName}`;
    const admin = new Client({ connectionString: ADMIN_DATABASE_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    t.after(async () => {
      try {
        await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()", [dbName]);
        await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
      } finally { await admin.end(); }
    });

    const smtp = await startMockSmtp();
    t.after(() => smtp.stop());
    const server = await startServer({
      env: {
        DATABASE_URL: testDbUrl,
        SMTP_HOST: "127.0.0.1", SMTP_PORT: String(smtp.port), SMTP_FROM: "hr@company.test",
        LEAVE_PROMOTION_TEST_DATE: "2026-07-03", HR_SCHEDULER_POLL_MS: "200",
      },
    });
    t.after(() => server.stop());
    const api = (path, options) => fetch(server.baseUrl + path, options);

    const reg = await (await api("/api/companies/register", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ companyName: "연차촉진회사", adminName: "관리자", loginId: "leave_admin_pg", password: "TestPassword123" }),
    })).json();
    assert.equal(reg.ok, true, `회사 가입 실패: ${JSON.stringify(reg)}`);
    const token = reg.token;

    const initial = await (await api("/data", { headers: { Authorization: `Bearer ${token}` } })).json();
    const employees = [
      ...initial.data.employees,
      { id: "pg-m1", loginId: "pg-m1", pw: "pg-m1-test-pw", name: "잔여직원", role: "member", active: true, dept: "영업본부", team: "영업1팀", email: "pg-m1@company.test", hire: "2020-01-15", menuPerms: {} },
    ];
    const seed = await api("/save", auth(token, "POST", {
      _version: initial.version,
      employees,
      settings: { ...(initial.data.settings || {}), leavePromotionMail: { enabled: true } },
    }));
    assert.equal(seed.status, 200);

    const deadline = Date.now() + 8000;
    while (smtp.received.length < 1 && Date.now() < deadline) await wait(100);
    await wait(800);
    assert.equal(smtp.received.length, 1, "같은 연도·차수에는 한 번만 발송");
    assert.deepEqual(smtp.received[0].to, ["pg-m1@company.test"]);

    const data = await (await api("/data", { headers: { Authorization: `Bearer ${token}` } })).json();
    const notices = data.data.leavePromotionNotices || [];
    assert.equal(notices.length, 1);
    assert.equal(notices[0].id, "lpn-2026-1-pg-m1");
    assert.equal(notices[0].round, 1);

    // PostgreSQL 모드의 /data는 DB에서 읽으므로, 위 응답에 기록이 보이는 것 자체가 DB 저장 확인이다.
  });
}
