// 확정(confirmed=true)된 급여명세서(payslips)는 어떤 방법으로도 값이 바뀌면 안 된다.
// 지금까지 이 보호는 클라이언트(applyPerformanceRewards() 등)에만 있었고 서버(/save)에는
// 없었다 — payslips는 _WRITE_GATED_FIELDS로 admin role만 게이팅될 뿐, "이미 확정된
// 레코드는 불변"이라는 비즈니스 규칙 자체가 서버에 없어 admin 권한(또는 탈취된 admin
// 세션)이 /save를 직접 호출하면 이미 확정된 남의 급여 숫자를 조용히 덮어쓸 수 있었다
// (2026-09-17, 병행 세션 PR #74 성과보상-급여 연동 감사에서 발견). confirmPayslip()은
// 단방향(확정 취소 UI 자체가 없음)이라 정상 화면은 confirmed 레코드를 다시 건드리지
// 않으므로, 이 보호는 정상 흐름을 막지 않으면서 API 직접 호출 우회만 차단한다.
//
// mkdtemp의 DATA_FILE, 랜덤 PORT, child process `node server.js`만 사용 — 실제 DB나
// 운영 데이터 파일은 이 테스트가 존재하는지조차 모른다.
"use strict";
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
async function getData(api, token) {
  const r = await (await api("/data", { headers: { Authorization: `Bearer ${token}` } })).json();
  assert.equal(r.ok, true);
  return r;
}

test("확정된 급여명세서는 /save 직접 호출로도 위조·덮어쓰기가 불가능하다", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const api = (path, options) => fetch(server.baseUrl + path, options);
  const boot = await bootstrapAdminAndLogin(server, { loginId: "admin", pw: "admin-test-pw-1", name: "관리자" });
  const token = boot.token;

  let d = await getData(api, token);
  const draft = { id: "payslip-1-2027-1", empId: 1, year: 2027, month: 1, gross: 3000000, netPay: 2700000, confirmed: false, updatedAt: new Date().toISOString() };

  await t.test("미확정 레코드는 정상적으로 저장·수정된다(회귀 확인)", async () => {
    const r = await (await api("/save", auth(token, "POST", { _version: d.version, payslips: [draft] }))).json();
    assert.equal(r.ok, true);
    d = await getData(api, token);
    const saved = d.data.payslips.find(p => p.id === draft.id);
    assert.equal(saved?.netPay, 2700000);
  });

  await t.test("확정(confirmed:true) 처리가 정상적으로 저장된다", async () => {
    const confirmed = { ...draft, confirmed: true, confirmedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    const r = await (await api("/save", auth(token, "POST", { _version: d.version, payslips: [confirmed] }))).json();
    assert.equal(r.ok, true);
    d = await getData(api, token);
    const saved = d.data.payslips.find(p => p.id === draft.id);
    assert.equal(saved?.confirmed, true);
  });

  await t.test("확정된 레코드를 다른 금액으로 재전송해도 서버가 되돌린다(응답은 200이지만 값은 불변)", async () => {
    const confirmed = d.data.payslips.find(p => p.id === draft.id);
    const tampered = { ...confirmed, netPay: 99000000, gross: 100000000, updatedAt: new Date().toISOString() };
    const r = await (await api("/save", auth(token, "POST", { _version: d.version, payslips: [tampered] }))).json();
    assert.equal(r.ok, true);
    d = await getData(api, token);
    const saved = d.data.payslips.find(p => p.id === draft.id);
    assert.equal(saved?.netPay, 2700000);
    assert.equal(saved?.gross, 3000000);
  });

  await t.test("updatedAt을 미래로 조작해도(CAS 우회 시도) 여전히 보호된다", async () => {
    const confirmed = d.data.payslips.find(p => p.id === draft.id);
    const tampered = { ...confirmed, netPay: 1, updatedAt: new Date(Date.now() + 86400000).toISOString() };
    const r = await (await api("/save", auth(token, "POST", { _version: d.version, payslips: [tampered] }))).json();
    assert.equal(r.ok, true);
    d = await getData(api, token);
    const saved = d.data.payslips.find(p => p.id === draft.id);
    assert.equal(saved?.netPay, 2700000);
  });

  await t.test("같은 요청에 실린 무관한 필드(게시글)는 과잉차단 없이 정상 반영된다", async () => {
    const confirmed = d.data.payslips.find(p => p.id === draft.id);
    const post = { id: "post-verify-1", title: "무관한 게시글", catId: "general", authorId: d.data.employees[0].id, updatedAt: new Date().toISOString() };
    const r = await (await api("/save", auth(token, "POST", {
      _version: d.version, boardPosts: [post], payslips: [{ ...confirmed, netPay: 5000000 }],
    }))).json();
    assert.equal(r.ok, true);
    d = await getData(api, token);
    assert.ok(d.data.boardPosts.some(p => p.id === "post-verify-1"));
    const saved = d.data.payslips.find(p => p.id === draft.id);
    assert.equal(saved?.netPay, 2700000);
  });
});

const ADMIN_DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!ADMIN_DATABASE_URL) {
  test("확정 급여명세서 보호 — Postgres 모드 (skipped: DATABASE_URL/TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  const { Client } = require("pg");

  test("확정된 급여명세서는 실제 PostgreSQL(운영 모드)에서도 위조·덮어쓰기가 불가능하다", async (t) => {
    const dbName = `hrtest_payslip_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
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

    const reg = await (await api("/api/companies/register", auth(null, "POST", {
      companyName: "급여보호테스트회사", adminName: "관리자", loginId: "admin_pay", password: "AdminPassw0rd1",
    }))).json();
    assert.equal(reg.ok, true);
    const token = reg.token;

    let d = await getData(api, token);
    const empId = d.data.employees[0].id;
    const draft = { id: `payslip-${empId}-2027-3`, empId, year: 2027, month: 3, gross: 4000000, netPay: 3600000, confirmed: false, updatedAt: new Date().toISOString() };

    let r = await (await api("/save", auth(token, "POST", { _version: d.version, payslips: [draft] }))).json();
    assert.equal(r.ok, true);

    d = await getData(api, token);
    const confirmed = { ...draft, confirmed: true, confirmedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    r = await (await api("/save", auth(token, "POST", { _version: d.version, payslips: [confirmed] }))).json();
    assert.equal(r.ok, true);

    d = await getData(api, token);
    let saved = d.data.payslips.find(p => p.id === draft.id);
    assert.equal(saved?.confirmed, true);

    const tampered = { ...saved, netPay: 99000000, updatedAt: new Date().toISOString() };
    r = await (await api("/save", auth(token, "POST", { _version: d.version, payslips: [tampered] }))).json();
    assert.equal(r.ok, true);

    d = await getData(api, token);
    saved = d.data.payslips.find(p => p.id === draft.id);
    assert.equal(saved?.netPay, 3600000, "Postgres 모드에서도 확정 급여는 위조되지 않아야 함");
  });
}
