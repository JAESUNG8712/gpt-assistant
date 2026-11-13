// 예약발령 서버 스케줄러. 발령일이 도래한 예약 인사발령(hrHistory applied:false)은 지금까지
// 관리자 브라우저가 열려 있을 때만 반영됐다. 서버가 주기적으로(HR_SCHEDULER_POLL_MS) 반영하는지,
// 허용 목록 밖 필드(role)는 무시하는지, 부서이동은 평가자 전환 표식을 남기는지, 퇴직 전환은
// 퇴직일을 채우고 기존 세션을 철회하는지 확인한다. 순수 계산은 lib/scheduled-hr.js 단위 테스트.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { computeDueHrChanges } = require("../lib/scheduled-hr");
const { startServer, bootstrapAdminAndLogin } = require("./support/start-server");

const NOW = "2099-06-10T00:00:00.000Z";

test("순수 계산 — 도래분만 반영하고 허용 목록·표식·퇴직일 보정을 지킨다", () => {
  const emps = [
    { id: 1, dept: "영업", team: "A", rank: "사원", role: "member", active: true, updatedAt: "2099-01-01", hrHistory: [
      { id: "h1", type: "transfer", date: "2099-06-10", applied: false, pendingUpdates: { dept: "기획", team: "B", role: "admin", salary: 5000000 } },
      { id: "h2", type: "promotion", date: "2099-06-11", applied: false, pendingUpdates: { rank: "대리" } },
      { id: "h3", type: "position", date: "2099-01-01", applied: true, pendingUpdates: null },
    ] },
    { id: 2, dept: "영업", team: "A", active: true, hrHistory: [
      { id: "h4", type: "retirement", date: "2099-06-01", applied: false, pendingUpdates: { active: false } },
    ] },
    { id: 3, dept: "영업", hrHistory: [{ id: "h5", date: "2099-06-01", applied: false, pendingUpdates: { role: "admin" } }] },
    { id: 4, dept: "영업", hrHistory: [{ id: "h6", date: "2099-06-01", applied: false, pendingUpdates: { salary: -5 } }] },
  ];
  const { employees, applied } = computeDueHrChanges(emps, "2099-06-10", NOW);
  const [a, b, c, d] = employees;
  assert.equal(a.dept, "기획"); assert.equal(a.team, "B"); assert.equal(a.salary, 5000000);
  assert.equal(a.role, "member", "role은 예약발령으로 바꿀 수 없다");
  assert.equal(a.rank, "사원", "발령일 전 항목은 미반영");
  assert.equal(a.updatedAt, NOW);
  assert.equal(a.hrHistory[0].applied, true); assert.equal(a.hrHistory[0].appliedBy, "server");
  assert.equal(a.hrHistory[0].transferPending, true);
  assert.deepEqual(a.hrHistory[0].transferFrom, { dept: "영업", team: "A" });
  assert.equal(a.hrHistory[1].applied, false);
  assert.equal(b.active, false); assert.equal(b.retireDate, "2099-06-01");
  assert.equal(c.role, undefined); assert.equal(c.hrHistory[0].applied, true);
  assert.equal(d.salary, undefined, "음수 연봉은 무시");
  assert.deepEqual(applied.map(x => x.empId), [1, 2, 3, 4]);
  assert.equal(computeDueHrChanges(employees, "2099-06-10", NOW).applied.length, 0, "두 번째 실행은 반영할 것이 없다(멱등)");
});

test("서버 스케줄러 — 접속자 없이 도래한 예약발령이 반영되고 퇴직 전환 시 기존 세션이 철회된다", async (t) => {
  const server = await startServer({ env: { HR_SCHEDULER_POLL_MS: "300" } });
  t.after(() => server.stop());
  const api = (p, o) => fetch(server.baseUrl + p, o);
  const hdr = (token) => ({ "Content-Type": "application/json", Authorization: `Bearer ${token}` });
  const admin = await bootstrapAdminAndLogin(server, { loginId: "admin1", pw: "admin-pw-123456", name: "관리자" });
  let d = await (await api("/data", { headers: hdr(admin.token) })).json();
  const past = "2000-01-01", future = "2999-01-01";
  const employees = [
    ...d.data.employees,
    { id: "m1", loginId: "m1", pw: "m1-pw-123456", name: "이동자", role: "member", active: true, dept: "영업", team: "A", rank: "사원", updatedAt: "2026-01-01T00:00:00.000Z",
      hrHistory: [{ id: "x1", type: "transfer", date: past, desc: "이동", applied: false, pendingUpdates: { dept: "기획", team: "B", rank: "대리", role: "admin" } },
        { id: "x2", type: "position", date: future, desc: "미래", applied: false, pendingUpdates: { position: "팀장" } }] },
    { id: "m2", loginId: "m2", pw: "m2-pw-123456", name: "퇴직자", role: "member", active: true, dept: "영업", team: "A", updatedAt: "2026-01-01T00:00:00.000Z",
      hrHistory: [{ id: "x3", type: "retirement", date: past, desc: "퇴직", applied: false, pendingUpdates: { active: false } }] },
  ];
  const saved = await (await api("/save", { method: "POST", headers: hdr(admin.token), body: JSON.stringify({ _version: d.version, employees: employees.map(e => e.id === "m2" ? { ...e, hrHistory: [] } : e) }) })).json();
  assert.equal(saved.ok, true, JSON.stringify(saved));
  // m2는 퇴직 예약을 넣기 전에 로그인해 토큰을 확보한다(스케줄러가 먼저 돌아 로그인이 막히는 경합 방지).
  const m2 = await (await api("/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ loginId: "m2", pw: "m2-pw-123456" }) })).json();
  assert.equal(m2.ok, true, JSON.stringify(m2));
  d = await (await api("/data", { headers: hdr(admin.token) })).json();
  const saved2 = await (await api("/save", { method: "POST", headers: hdr(admin.token), body: JSON.stringify({ _version: d.version,
    employees: d.data.employees.map(e => e.id === "m2" ? { ...e, updatedAt: "2026-02-01T00:00:00.000Z", hrHistory: employees.find(x => x.id === "m2").hrHistory } : e) }) })).json();
  assert.equal(saved2.ok, true, JSON.stringify(saved2));
  const find = async (id) => (await (await api("/data", { headers: hdr(admin.token) })).json()).data.employees.find(e => e.id === id);
  // 위 /save 직후 워커가 돌 수 있으므로 반영될 때까지 기다린다.
  const waitFor = async (fn, ms = 15000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await new Promise(r => setTimeout(r, 200)); } };
  const moved = await waitFor(async () => { const e = await find("m1"); return e.dept === "기획" ? e : null; });
  assert.ok(moved, "도래한 예약발령이 서버에서 반영돼야 한다");
  assert.equal(moved.team, "B"); assert.equal(moved.rank, "대리");
  assert.equal(moved.role, "member", "role 변경 시도는 무시");
  assert.equal(moved.hrHistory.find(h => h.id === "x1").applied, true);
  assert.equal(moved.hrHistory.find(h => h.id === "x1").transferPending, true);
  assert.equal(moved.hrHistory.find(h => h.id === "x2").applied, false, "미래 발령은 대기");
  const retired = await waitFor(async () => { const e = await find("m2"); return e.active === false ? e : null; });
  assert.ok(retired);
  assert.equal(retired.retireDate, past);
  const stale = await api("/data", { headers: hdr(m2.token) });
  assert.equal(stale.status, 401, "퇴직 전환 후 기존 세션은 철회돼야 한다");
});

const ADMIN_DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!ADMIN_DATABASE_URL) {
  test("서버 스케줄러 — 실제 PostgreSQL (skipped: DATABASE_URL/TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  const { Client } = require("pg");
  test("서버 스케줄러 — 실제 PostgreSQL 모드에서 회사별로 반영되고 정지된 회사·다른 회사는 건드리지 않는다", async (t) => {
    const dbName = `hrtest_schedhr_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
    const adminDb = new Client({ connectionString: ADMIN_DATABASE_URL });
    await adminDb.connect();
    await adminDb.query(`CREATE DATABASE ${dbName}`);
    t.after(async () => {
      try {
        await adminDb.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()", [dbName]);
        await adminDb.query(`DROP DATABASE IF EXISTS ${dbName}`);
      } finally { await adminDb.end(); }
    });
    const base = ADMIN_DATABASE_URL.replace(/\/[^/]*(\?.*)?$/, "");
    const server = await startServer({ env: { DATABASE_URL: `${base}/${dbName}`, HR_SCHEDULER_POLL_MS: "300" } });
    t.after(() => server.stop());
    const api = (p, o) => fetch(server.baseUrl + p, o);
    const hdr = (token) => ({ "Content-Type": "application/json", Authorization: `Bearer ${token}` });
    const register = async (name, loginId) => (await (await api("/api/companies/register", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ companyName: name, adminName: "관리자", loginId, password: "TestPassword123" }),
    })).json());
    const a = await register("스케줄A", "admina");
    const b = await register("스케줄B", "adminb");
    assert.ok(a.ok && b.ok);
    const seed = async (co, id, date) => {
      const d = await (await api("/data", { headers: hdr(co.token) })).json();
      const emp = { id, loginId: `u${id}`, pw: "u-pw-123456", name: `직원${id}`, role: "member", active: true, dept: "영업", team: "A",
        updatedAt: "2026-01-01T00:00:00.000Z",
        hrHistory: [{ id: `h${id}`, type: "transfer", date, desc: "이동", applied: false, pendingUpdates: { dept: "기획", team: "B", role: "admin" } }] };
      const r = await (await api("/save", { method: "POST", headers: hdr(co.token), body: JSON.stringify({ _version: d.version, employees: [...d.data.employees, emp] }) })).json();
      assert.equal(r.ok, true, JSON.stringify(r));
    };
    await seed(a, 9301, "2000-01-01");
    await seed(b, 9302, "2999-01-01");
    const bdb = new Client({ connectionString: `${base}/${dbName}` });
    bdb.on("error", () => {});
    await bdb.connect();
    t.after(() => bdb.end());
    await bdb.query("BEGIN");
    try {
      assert.equal((await bdb.query("UPDATE companies SET status = 'suspended' WHERE id = $1", [b.company.id])).rowCount, 1);
      // Make the transfer due in the same commit as suspension, never while B is active.
      assert.equal((await bdb.query("UPDATE employees SET data = jsonb_set(data, '{hrHistory,0,date}', to_jsonb($1::text)) WHERE id = '9302' AND company_id = $2", ["2000-01-01", b.company.id])).rowCount, 1);
      await bdb.query("COMMIT");
    } catch (error) {
      await bdb.query("ROLLBACK");
      throw error;
    }
    const end = Date.now() + 15000;
    let emp;
    for (;;) {
      const { rows } = await bdb.query("SELECT data FROM employees WHERE id = '9301'");
      emp = rows[0]?.data;
      if (emp?.dept === "기획" || Date.now() > end) break;
      await new Promise(r => setTimeout(r, 200));
    }
    assert.equal(emp.dept, "기획"); assert.equal(emp.team, "B");
    assert.equal(emp.role, "member");
    assert.equal(emp.hrHistory[0].transferPending, true);
    const { rows: hist } = await bdb.query("SELECT changed_by FROM employee_history WHERE employee_id = '9301' AND action = 'update' ORDER BY history_id DESC LIMIT 1");
    assert.equal(hist[0].changed_by, "system:scheduled-hr");
    await new Promise(r => setTimeout(r, 1500));
    const { rows: other } = await bdb.query("SELECT data FROM employees WHERE id = '9302'");
    assert.equal(other[0].data.dept, "영업", "정지된 회사의 예약발령은 반영하지 않는다");
  });
}
