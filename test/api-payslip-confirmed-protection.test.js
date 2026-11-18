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
const { brief } = require("./support/save-feedback");
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

// Both storage modes exercise actual saves and reloads, rather than UI-only arrays.
async function exercisePayrollIntegrity(api, token) {
  const read = () => getData(api, token);
  const save = async (payload) => {
    const d = await read();
    const r = await (await api("/save", auth(token, "POST", {
      _version: d.version, _singletonRevisions: d.data._singletonRevisions, ...payload,
    }))).json();
    assert.equal(r.ok, true, JSON.stringify(r));
    return r;
  };
  let d = await read();
  const empId = d.data.employees[0].id;
  const adjustment = { id: "integrity-adjustment", empId, year: 2098, month: 1,
    amount: 500000, category: "성과급", source: "performance_reward", evalYear: 2097,
    sourceKey: `performance:2097:${empId}`, updatedAt: "2098-01-01T00:00:00Z" };
  await save({ payrollAdjustments: [adjustment] });
  let r = await save({ payrollAdjustments: [{ ...adjustment, id: "duplicate-source" }] });
  assert.equal(r.partial, true, "same employee/evaluation reward must not be paid twice");
  assert.equal((await read()).data.payrollAdjustments.filter(a => a.sourceKey === adjustment.sourceKey).length, 1);
  r = await save({ payrollAdjustments: [{ ...adjustment, id: "forged-source", sourceKey: "different-key" }] });
  assert.equal(r.partial, true, "performance source key must match employee and evaluation year");
  const batch = { ...adjustment, evalYear: 2096, sourceKey: `performance:2096:${empId}` };
  r = await save({ payrollAdjustments: [{ ...batch, id: "batch-a" }, { ...batch, id: "batch-b" }] });
  assert.equal(r.partial, true);
  assert.equal((await read()).data.payrollAdjustments.filter(a => a.sourceKey === batch.sourceKey).length, 1);
  r = await save({ payrollAdjustments: [
    { ...batch, id: "batch-a", evalYear: 2094, sourceKey: `performance:2094:${empId}`, updatedAt: "2097-01-01T00:00:00Z" },
    { ...batch, id: "stale-key-reuse" },
  ] });
  assert.equal(r.partial, true);
  assert.equal((await read()).data.payrollAdjustments.filter(a => a.sourceKey === batch.sourceKey).length, 1,
    "a rejected stale update must not free the original reward key");
  const concurrent = { ...adjustment, evalYear: 2095, sourceKey: `performance:2095:${empId}` };
  d = await read();
  const replies = await Promise.all(["parallel-a", "parallel-b"].map(id =>
    api("/save", auth(token, "POST", { _version: d.version, payrollAdjustments: [{ ...concurrent, id }] }))
      .then(r => r.json())));
  assert.ok(replies.some(r => r.ok));
  assert.equal((await read()).data.payrollAdjustments.filter(a => a.sourceKey === concurrent.sourceKey).length, 1);

  // 장기근속 포상은 UI의 고정 id가 아니라 직원×근속연수 정규 sourceKey로 중복을
  // 판정한다. 취소 후 재반영은 tombstone 때문에 id가 달라질 수 있으므로 id만 고정하면
  // 정상 재반영을 막거나, 반대로 임의 id/sourceKey로 같은 포상을 반복 지급할 수 있다.
  d = await read();
  const employee = d.data.employees.find(e => String(e.id) === String(empId));
  const serviceHistory = { id: `hh-longservice-${empId}-5`, type: "longservice", year: 5,
    date: "2097-06-01", desc: "5년 장기근속 포상", amount: 500000 };
  const serviceSlip = { id: `payslip-${empId}-2097-6`, empId, year: 2097, month: 6,
    gross: 3500000, netPay: 3000000, confirmed: false, updatedAt: "2097-06-01T00:00:00Z" };
  const serviceAward = { id: `payadj-longservice-${empId}-5`, empId, year: 2097, month: 6,
    amount: 500000, category: "장기근속 포상금", source: "longservice_award",
    sourceKey: `longservice-${empId}-5`, longServiceYears: 5, taxable: true,
    updatedAt: "2097-06-01T00:00:00Z" };
  r = await save({
    employees: [{ ...employee, hrHistory: [...(employee.hrHistory || []), serviceHistory], updatedAt: "2097-06-01T00:00:00Z" }],
    payslips: [serviceSlip], payrollAdjustments: [serviceAward],
  });
  assert.notEqual(r.partial, true, "정규 장기근속 포상은 저장되어야 한다");

  // 동일 레코드의 네트워크 재전송은 새 급여 조정이나 이력/명세서를 만들지 않는다.
  await save({ payrollAdjustments: [serviceAward] });
  d = await read();
  assert.equal(d.data.payrollAdjustments.filter(a => a.sourceKey === serviceAward.sourceKey).length, 1);
  assert.equal(d.data.employees.find(e => String(e.id) === String(empId)).hrHistory
    .filter(h => h.id === serviceHistory.id).length, 1);
  assert.equal(d.data.payslips.filter(p => p.id === serviceSlip.id).length, 1);

  r = await save({ payrollAdjustments: [{ ...serviceAward, id: "longservice-forged-key", month: 7,
    sourceKey: `longservice-${empId}-forged` }] });
  assert.equal(r.partial, true, "같은 장기근속 포상의 임의 sourceKey는 거부해야 한다");
  r = await save({ payrollAdjustments: [{ ...serviceAward, id: "longservice-duplicate", month: 7 }] });
  assert.equal(r.partial, true, "정규 sourceKey가 같은 별도 레코드는 거부해야 한다");

  const serviceBatch = { ...serviceAward, longServiceYears: 10, sourceKey: `longservice-${empId}-10`,
    year: 2098, month: 1, updatedAt: "2098-01-01T00:00:00Z" };
  r = await save({ payrollAdjustments: [
    { ...serviceBatch, id: "longservice-batch-a" }, { ...serviceBatch, id: "longservice-batch-b" },
  ] });
  assert.equal(r.partial, true);
  assert.equal((await read()).data.payrollAdjustments.filter(a => a.sourceKey === serviceBatch.sourceKey).length, 1);

  const serviceConcurrent = { ...serviceAward, longServiceYears: 15, sourceKey: `longservice-${empId}-15`,
    year: 2098, month: 2, updatedAt: "2098-02-01T00:00:00Z" };
  d = await read();
  await Promise.all(["longservice-parallel-a", "longservice-parallel-b"].map(id =>
    api("/save", auth(token, "POST", { _version: d.version, payrollAdjustments: [{ ...serviceConcurrent, id }] }))
      .then(response => response.json())));
  d = await read();
  assert.equal(d.data.payrollAdjustments.filter(a => a.sourceKey === serviceConcurrent.sourceKey).length, 1,
    "동시 생성도 장기근속 포상을 한 건만 남겨야 한다");
  assert.equal(d.data.employees.find(e => String(e.id) === String(empId)).hrHistory
    .filter(h => h.id === serviceHistory.id).length, 1, "중복 거부가 포상이력을 복제하면 안 된다");
  assert.equal(d.data.payslips.find(p => p.id === serviceSlip.id).gross, serviceSlip.gross,
    "중복 거부가 연결 급여명세서를 덮어쓰면 안 된다");

  d = await read();
  await save({ settings: { ...d.data.settings, payrollLockedMonths: ["2098-1", "2098-02"] } });
  r = await save({ payrollAdjustments: [
    { ...adjustment, month: 3, amount: 1, updatedAt: "2099-01-01T00:00:00Z" },
    { id: "locked-new", empId, year: 2098, month: 2, amount: 100, category: "수당" },
    { id: "safe-new", empId, year: 2098, month: 3, amount: 200, category: "수당" },
  ] });
  assert.equal(r.partial, true);
  d = await read();
  assert.equal(d.data.payrollAdjustments.find(a => a.id === adjustment.id).amount, 500000);
  assert.equal(d.data.payrollAdjustments.find(a => a.id === adjustment.id).month, 1);
  assert.equal(d.data.payrollAdjustments.some(a => a.id === "locked-new"), false);
  assert.equal(d.data.payrollAdjustments.find(a => a.id === "safe-new").amount, 200);
  r = await save({ payslips: [{ id: "closed-month-slip", empId, year: 2098, month: 2, gross: 1000, netPay: 900 }] });
  assert.equal(r.partial, true);
  assert.equal((await read()).data.payslips.some(p => p.id === "closed-month-slip"), false);

  // A same-request unlock cannot bypass the previously persisted lock.
  r = await save({ settings: { ...d.data.settings, payrollLockedMonths: [] },
    recordTombstones: { payrollAdjustments: [{ id: adjustment.id, deletedAt: new Date().toISOString() }] } });
  assert.equal(r.partial, true);
  d = await read();
  assert.ok(d.data.payrollAdjustments.some(a => a.id === adjustment.id));
  assert.equal((d.data.recordTombstones?.payrollAdjustments || []).some(a => a.id === adjustment.id), false);
  r = await save({ payrollAdjustments: [{ ...adjustment, amount: 600000, updatedAt: "2099-01-01T00:00:00Z" }] });
  assert.notEqual(r.partial, true, "a separately completed unlock permits editing");

  const slip = { id: "integrity-confirmed", empId, year: 2098, month: 3, gross: 1000, netPay: 900, confirmed: true };
  await save({ payslips: [slip] });
  r = await save({ payrollAdjustments: [
    { id: "confirmed-new", empId, year: 2098, month: 3, amount: 300, category: "수당" },
    { id: "safe-new", empId, year: 2098, month: 4, amount: 999, category: "수당" },
  ], recordTombstones: { payslips: [{ id: slip.id }], payrollAdjustments: [{ id: "safe-new" }] } });
  assert.equal(r.partial, true);
  d = await read();
  assert.ok(d.data.payslips.some(p => p.id === slip.id));
  assert.equal(d.data.payrollAdjustments.some(a => a.id === "confirmed-new"), false);
  assert.equal(d.data.payrollAdjustments.find(a => a.id === "safe-new").amount, 200);
}

test("급여 마감·확정 및 성과급 중복 보호 — JSON 실제 저장", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const boot = await bootstrapAdminAndLogin(server, { loginId: "admin", pw: "admin-test-pw-1" });
  await exercisePayrollIntegrity((p, o) => fetch(server.baseUrl + p, o), boot.token);
});

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

  await t.test("확정된 레코드의 변경은 부분 거부로 알리고 값은 불변이다", async () => {
    const confirmed = d.data.payslips.find(p => p.id === draft.id);
    const tampered = { ...confirmed, netPay: 99000000, gross: 100000000, updatedAt: new Date().toISOString() };
    const r = await (await api("/save", auth(token, "POST", { _version: d.version, payslips: [tampered] }))).json();
    assert.equal(r.ok, true);
    assert.equal(r.partial, true);
    assert.deepEqual(brief(r.warnings?.rejectedRecords), [{ field: "payslips", id: draft.id }]);
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
    assert.equal(r.partial, true);
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
    assert.equal(r.partial, true);
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
    assert.equal(r.partial, true);

    d = await getData(api, token);
    saved = d.data.payslips.find(p => p.id === draft.id);
    assert.equal(saved?.netPay, 3600000, "Postgres 모드에서도 확정 급여는 위조되지 않아야 함");
    await exercisePayrollIntegrity(api, token);
  });
}
