"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createLongServiceBundleIntent,
  assertLongServiceBundleIntegrity,
} = require("../lib/long-service-integrity");

const sourceKey = "longservice-e1-10";
const adjustment = {
  id: "lsa-e1-10", empId: "e1", year: 2026, month: 11,
  amount: 1000000, source: "longservice_award", sourceKey,
  longServiceYears: 10,
};
const history = {
  id: "lsh-e1-10", type: "longservice", year: 10,
  desc: "10년 장기근속 포상", after: "1,000,000원 (2026-11 급여 반영)",
};
const payslipBefore = { id: "p1", empId: "e1", year: 2026, month: 11, bonus: 0 };
const payslipAfter = { ...payslipBefore, bonus: 1000000 };

function state({ withAdjustment = false, withHistory = false, payslip = payslipBefore } = {}) {
  return {
    employees: [{ id: "e1", hrHistory: withHistory ? [history] : [] }],
    payrollAdjustments: withAdjustment ? [adjustment] : [],
    payslips: payslip ? [payslip] : [],
  };
}

test("장기근속 적용은 조정·이력·변경된 명세가 함께 반영될 때 통과한다", () => {
  const before = state();
  const requested = state({ withAdjustment: true, withHistory: true, payslip: payslipAfter });
  const intent = createLongServiceBundleIntent(before, requested);
  assert.equal(intent.length, 1);
  assert.doesNotThrow(() => assertLongServiceBundleIntegrity(intent, requested));
});

test("급여 조정이 거부되고 인사이력만 반영되면 전체 저장을 409로 중단한다", () => {
  const before = state();
  const requested = state({ withAdjustment: true, withHistory: true, payslip: payslipAfter });
  const partial = state({ withHistory: true, payslip: payslipAfter });
  const intent = createLongServiceBundleIntent(before, requested);
  assert.throws(
    () => assertLongServiceBundleIntegrity(intent, partial),
    error => error.status === 409 && error.code === "LONG_SERVICE_BUNDLE_CONFLICT"
  );
});

test("취소 시 이력만 삭제되고 급여 조정이 남으면 전체 저장을 중단한다", () => {
  const before = state({ withAdjustment: true, withHistory: true, payslip: payslipAfter });
  const requested = state({ payslip: payslipBefore });
  requested.recordTombstones = { payrollAdjustments: [{ id: adjustment.id }] };
  const partial = state({ withAdjustment: true, payslip: payslipBefore });
  const intent = createLongServiceBundleIntent(before, requested);
  assert.throws(() => assertLongServiceBundleIntegrity(intent, partial), /함께 저장하지 못했습니다/);
});

test("연결된 명세 변경만 거부돼도 묶음 저장을 중단한다", () => {
  const before = state();
  const requested = state({ withAdjustment: true, withHistory: true, payslip: payslipAfter });
  const partial = state({ withAdjustment: true, withHistory: true, payslip: payslipBefore });
  const intent = createLongServiceBundleIntent(before, requested);
  assert.throws(() => assertLongServiceBundleIntegrity(intent, partial), /함께 저장하지 못했습니다/);
});

test("인사이력을 건드리지 않은 독립 급여 조정은 기존 partial 계약을 유지한다", () => {
  const before = state();
  const requested = state({ withAdjustment: true });
  assert.equal(createLongServiceBundleIntent(before, requested), null);
});

test("omitted arrays and empty partial arrays do not imply deletion", () => {
  const before = state({ withAdjustment: true, withHistory: true, payslip: payslipAfter });
  for (const request of [{ boardPosts: [] }, { employees: [] }, { payrollAdjustments: [] },
    { employees: [{ id: "e1", name: "Updated name" }] }]) {
    assert.equal(createLongServiceBundleIntent(before, request), null);
  }
});

const { startServer, bootstrapAdminAndLogin } = require("./support/start-server");
async function exerciseLinkedSave(t, server, token) {
  const api = async (path, method = "GET", body) => {
    const response = await fetch(server.baseUrl + path, { method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, ...await response.json() };
  };
  const read = () => api("/data");
  const save = async payload => {
    const current = await read();
    return api("/save", "POST", { _version: current.version,
      _singletonRevisions: current.data._singletonRevisions, ...payload });
  };
  let d = await read();
  const employee = d.data.employees[0];
  const award = { id: "linked-award", empId: employee.id, year: 2095, month: 1,
    amount: 500000, category: "장기근속 포상금", source: "longservice_award",
    sourceKey: `longservice-${employee.id}-5`, longServiceYears: 5 };
  const entry = { id: "linked-history", type: "longservice", year: 5, amount: 500000 };
  const slip = { id: "linked-slip", empId: employee.id, year: 2095, month: 1,
    gross: 3500000, netPay: 3000000, confirmed: false };
  const reply = await save({ employees: [{ ...employee, hrHistory: [entry] }],
    payrollAdjustments: [award], payslips: [slip] });
  assert.equal(reply.status, 200, JSON.stringify(reply));
  assert.notEqual(reply.partial, true, JSON.stringify(reply));

  await t.test("unrelated partial saves remain available after a linked award exists", async () => {
    const reply = await save({ boardPosts: [{ id: "unrelated-post", title: "Test", authorId: employee.id }] });
    assert.equal(reply.status, 200, JSON.stringify(reply));
    assert.ok((await read()).data.boardPosts.some(row => row.id === "unrelated-post"));
  });

  await t.test("duplicate award plus changed history and slip rolls back every linked change", async () => {
    d = await read();
    const emp = d.data.employees.find(row => row.id === employee.id);
    const reply = await save({ employees: [{ ...emp, hrHistory: [{ ...entry, amount: 999999 }] }],
      payrollAdjustments: [{ ...award, id: "duplicate-linked-award", amount: 999999 }],
      payslips: [{ ...slip, gross: 9999999 }] });
    assert.equal(reply.status, 409, JSON.stringify(reply));
    assert.equal(reply.code, "LONG_SERVICE_BUNDLE_CONFLICT");
    const after = (await read()).data;
    assert.deepEqual(after.employees.find(row => row.id === employee.id).hrHistory, emp.hrHistory);
    assert.deepEqual(after.payrollAdjustments, d.data.payrollAdjustments);
    assert.deepEqual(after.payslips, d.data.payslips);
  });

  await t.test("closed-month cancellation cannot remove only history", async () => {
    d = await read();
    assert.equal((await save({ settings: { ...d.data.settings, payrollLockedMonths: ["2095-01"] } })).status, 200);
    d = await read();
    const emp = d.data.employees.find(row => row.id === employee.id);
    const reply = await save({ employees: [{ ...emp, hrHistory: [] }],
      payrollAdjustments: [], recordTombstones: { payrollAdjustments: [{ id: award.id }] },
      payslips: [{ ...slip, gross: 3000000 }] });
    assert.equal(reply.status, 409, JSON.stringify(reply));
    const after = (await read()).data;
    assert.deepEqual(after.employees.find(row => row.id === employee.id).hrHistory, emp.hrHistory);
    assert.deepEqual(after.payrollAdjustments, d.data.payrollAdjustments);
    assert.deepEqual(after.payslips, d.data.payslips);
    assert.ok(!(after.recordTombstones?.payrollAdjustments || []).some(row => row.id === award.id));
    assert.equal((await save({ settings: { ...after.settings, payrollLockedMonths: [] } })).status, 200);
  });

  await t.test("denied payroll menu cannot save only the HR half of a new award", async () => {
    d = await read();
    const emp = d.data.employees.find(row => row.id === employee.id);
    const denied = { ...emp, menuPerms: { ...emp.menuPerms, "payroll-mgmt": false } };
    assert.equal((await save({ employees: [denied] })).status, 200);
    const reply = await save({ employees: [{ ...denied, hrHistory: [...emp.hrHistory, { ...entry, id: "new-history", year: 10 }] }],
      payrollAdjustments: [{ ...award, id: "new-award", month: 2, longServiceYears: 10,
        sourceKey: `longservice-${employee.id}-10` }] });
    assert.equal(reply.status, 409, JSON.stringify(reply));
    assert.equal((await save({ employees: [{ ...denied, menuPerms: { ...emp.menuPerms, "payroll-mgmt": true } }] })).status, 200);
    const after = (await read()).data;
    assert.deepEqual(after.employees.find(row => row.id === employee.id).hrHistory, emp.hrHistory);
    assert.deepEqual(after.payrollAdjustments, d.data.payrollAdjustments);
  });

  await t.test("valid cancellation removes award and history together", async () => {
    d = await read();
    const emp = d.data.employees.find(row => row.id === employee.id);
    const reply = await save({ employees: [{ ...emp, hrHistory: [] }],
      recordTombstones: { payrollAdjustments: [{ id: award.id }] }, payslips: [{ ...slip, gross: 3000000 }] });
    assert.equal(reply.status, 200, JSON.stringify(reply));
    const after = (await read()).data;
    assert.equal(after.employees.find(row => row.id === employee.id).hrHistory.length, 0);
    assert.ok(!after.payrollAdjustments.some(row => row.id === award.id));
    assert.equal(after.payslips.find(row => row.id === slip.id).gross, 3000000);
  });
}

test("linked long-service saves — isolated JSON API", async t => {
  const server = await startServer();
  t.after(() => server.stop());
  const { token } = await bootstrapAdminAndLogin(server, { loginId: "bundleadmin", pw: "BundleTestPass123!" });
  await exerciseLinkedSave(t, server, token);
});

const testDb = process.env.TEST_DATABASE_URL;
test("linked long-service saves — disposable PostgreSQL API", { skip: !testDb }, async t => {
  const { Client } = require("pg");
  const admin = new Client({ connectionString: testDb });
  await admin.connect();
  const name = `hrtest_bundle_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
  await admin.query(`CREATE DATABASE ${name}`);
  let server;
  t.after(async () => {
    if (server) await server.stop();
    try {
      await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()", [name]);
      await admin.query(`DROP DATABASE ${name}`);
    } finally { await admin.end(); }
  });
  const url = new URL(testDb); url.pathname = "/" + name;
  server = await startServer({ env: { DATABASE_URL: url.toString() } });
  const registered = await (await fetch(server.baseUrl + "/api/companies/register", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ companyName: "Bundle test", adminName: "Test admin", loginId: "bundleadmin", password: "BundleTestPass123!" }),
  })).json();
  assert.equal(registered.ok, true, JSON.stringify(registered));
  await exerciseLinkedSave(t, server, registered.token);
});

