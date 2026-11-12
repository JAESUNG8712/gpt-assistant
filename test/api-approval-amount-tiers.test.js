// 결재 금액 구간별 추가 결재자(approvalChainSettings.amountTiers)의 서버 강제.
// 구간 규정은 상신 화면(_applyApprovalAmountTiers)이 결재선에 결재자를 "추가"하는 규칙인데,
// 결재선은 상신 직전에 사용자가 직접 고칠 수 있고 서버는 새 문서의 결재선 구성을 검증하지
// 않아, API를 직접 호출하면 고액 문서도 구간 결재자 없이 상신할 수 있었다(수정 전 재현).
// 서버는 저장본의 구간 설정(클라이언트가 보낸 값이 아님)으로 새 문서에 필요한 결재자가
// 결재선에 있는지 확인한다. 대결자로 치환된 경우(originalEmpId)·재직하지 않는 결재자·본인
// 문서·양식 지정 구간 불일치·관리자는 요구/차단 대상이 아니다.
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
async function login(api, loginId, pw) {
  const r = await (await api("/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ loginId, pw }),
  })).json();
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.token;
}

test("금액 구간 결재자 서버 강제 — 필요한 결재자가 빠진 새 문서는 거부되고 정상 문서는 통과한다", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const api = (path, options) => fetch(server.baseUrl + path, options);
  const admin = await bootstrapAdminAndLogin(server, { loginId: "admin1", pw: "admin-pw-123456", name: "관리자" });

  let d = await getData(api, admin.token);
  const employees = [
    ...d.data.employees,
    { id: "mem1", loginId: "mem1", pw: "mem-pw-123456", name: "기안자", role: "member", active: true, dept: "영업", team: "A" },
    { id: "lead1", loginId: "lead1", pw: "lead-pw-123456", name: "팀장", role: "leader", active: true, dept: "영업", team: "A" },
    { id: "cfo", loginId: "cfo", pw: "cfo-pw-123456", name: "재무임원", role: "director", active: true, dept: "재무", team: "" },
    { id: "gone", loginId: "gone", pw: "gone-pw-123456", name: "퇴직임원", role: "director", active: false, dept: "재무", team: "" },
    { id: "deputy", loginId: "deputy", pw: "dep-pw-123456", name: "대결자", role: "director", active: true, dept: "재무", team: "" },
  ];
  assert.equal((await (await api("/save", auth(admin.token, "POST", { _version: d.version, employees }))).json()).ok, true);
  const mem = await login(api, "mem1", "mem-pw-123456");

  const setTiers = async (amountTiers) => {
    d = await getData(api, admin.token);
    const r = await (await api("/save", auth(admin.token, "POST", {
      _version: d.version, _singletonRevisions: d.data._singletonRevisions,
      approvalChainSettings: { includeLeader: true, includeDirector: true, finalApprovers: [], reminderDays: 2, amountTiers },
    }))).json();
    assert.equal(r.ok, true, JSON.stringify(r));
  };
  let seq = 0;
  const submit = async (token, { approvers, amount, tplId = "tpl-expense", authorId = "mem1" }) => {
    const id = `doc-${++seq}`;
    const doc = {
      id, templateId: tplId, authorId, title: `테스트 ${id}`, createdAt: "2099-01-01T00:00:00.000Z", updatedAt: "2099-01-01T00:00:00.000Z",
      status: "in_progress", formData: { amount }, receivers: [], cc: [], attachments: [],
      approvers: approvers.map((a, i) => ({ decidedAt: null, comment: "", label: "결재", ...a, status: i === 0 ? "pending" : "waiting" })),
    };
    const dd = await getData(api, token);
    const r = await (await api("/save", auth(token, "POST", { _version: dd.version, approvalDocs: [doc] }))).json();
    const stored = (await getData(api, admin.token)).data.approvalDocs.some(x => x.id === id);
    return { r, stored, id };
  };
  const lead = [{ empId: "lead1", label: "팀장" }];

  await t.test("구간 설정이 없으면 기존처럼 어떤 금액이든 통과", async () => {
    const x = await submit(mem, { approvers: lead, amount: 99999999 });
    assert.equal(x.stored, true);
  });

  await setTiers([{ minAmount: 1000000, empId: "cfo", label: "재무 결재" }]);

  await t.test("기준 금액 미만이면 구간 결재자 없이도 통과", async () => {
    const x = await submit(mem, { approvers: lead, amount: 999999 });
    assert.equal(x.stored, true);
  });
  await t.test("기준 금액 이상인데 구간 결재자가 빠지면 거부되고 사유 코드가 내려온다", async () => {
    const x = await submit(mem, { approvers: lead, amount: 5000000 });
    assert.equal(x.stored, false);
    const rec = (x.r.warnings?.rejectedRecords || []).find(v => v.field === "approvalDocs" && v.id === x.id);
    assert.ok(rec, JSON.stringify(x.r));
    assert.equal(rec.reason, "APPROVAL_TIER_MISSING");
  });
  await t.test("구간 결재자를 결재선에 넣으면 통과", async () => {
    const x = await submit(mem, { approvers: [...lead, { empId: "cfo", label: "재무 결재" }], amount: 5000000 });
    assert.equal(x.stored, true);
  });
  await t.test("대결자로 치환된 경우(originalEmpId)도 인정", async () => {
    const x = await submit(mem, { approvers: [...lead, { empId: "deputy", originalEmpId: "cfo", label: "재무 결재" }], amount: 5000000 });
    assert.equal(x.stored, true);
  });
  await t.test("requestedAmount·estimatedCost·budget 금액 키도 같은 기준으로 판정", async () => {
    for (const key of ["requestedAmount", "estimatedCost", "budget"]) {
      const id = `doc-key-${key}`;
      const dd = await getData(api, mem);
      await api("/save", auth(mem, "POST", { _version: dd.version, approvalDocs: [{
        id, templateId: "tpl-x", authorId: "mem1", title: id, createdAt: "2099-01-01T00:00:00.000Z", updatedAt: "2099-01-01T00:00:00.000Z",
        status: "in_progress", formData: { [key]: 3000000 }, receivers: [], cc: [], attachments: [],
        approvers: [{ empId: "lead1", label: "팀장", status: "pending", decidedAt: null, comment: "" }],
      }] }));
      assert.equal((await getData(api, admin.token)).data.approvalDocs.some(x => x.id === id), false, key);
    }
  });

  await t.test("재직하지 않는 구간 결재자는 요구하지 않는다(클라이언트도 결재선에 넣지 않음)", async () => {
    await setTiers([{ minAmount: 1000000, empId: "gone", label: "퇴직" }]);
    const x = await submit(mem, { approvers: lead, amount: 5000000 });
    assert.equal(x.stored, true);
  });
  await t.test("양식 지정 구간은 해당 양식에서만 요구한다", async () => {
    await setTiers([{ minAmount: 1000000, empId: "cfo", label: "재무 결재", tplIds: ["tpl-expense"] }]);
    assert.equal((await submit(mem, { approvers: lead, amount: 5000000, tplId: "tpl-leave" })).stored, true);
    assert.equal((await submit(mem, { approvers: lead, amount: 5000000, tplId: "tpl-expense" })).stored, false);
  });
  await t.test("관리자는 구간 결재자 없이도 상신할 수 있다(결재선 교체 권한 유지)", async () => {
    const x = await submit(admin.token, { approvers: [{ empId: "lead1", label: "팀장" }], amount: 5000000, authorId: admin.employee?.id ?? "x" });
    // 관리자는 본인 명의 요구도 받지 않으므로 저장 여부만 확인한다.
    assert.equal(x.stored, true);
  });
  await t.test("이미 저장된 문서의 이후 수정(결재 처리)은 이 규칙의 영향을 받지 않는다", async () => {
    await setTiers([]);
    const ok = await submit(mem, { approvers: lead, amount: 5000000 });
    assert.equal(ok.stored, true);
    await setTiers([{ minAmount: 1000000, empId: "cfo", label: "재무 결재" }]);
    const leadToken = await login(api, "lead1", "lead-pw-123456");
    const dd = await getData(api, leadToken);
    const doc = dd.data.approvalDocs.find(x => x.id === ok.id);
    const next = { ...doc, status: "approved", updatedAt: "2099-01-02T00:00:00.000Z", approvedAt: "2099-01-02T00:00:00.000Z",
      approvers: doc.approvers.map(a => ({ ...a, status: "approved", decidedAt: "2099-01-02T00:00:00.000Z" })) };
    const r = await (await api("/save", auth(leadToken, "POST", { _version: dd.version, approvalDocs: [next] }))).json();
    assert.equal(r.ok, true);
    assert.equal((await getData(api, admin.token)).data.approvalDocs.find(x => x.id === ok.id).status, "approved");
  });
});

const ADMIN_DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!ADMIN_DATABASE_URL) {
  test("금액 구간 결재자 서버 강제 — 실제 PostgreSQL (skipped: DATABASE_URL/TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  const { Client } = require("pg");
  test("금액 구간 결재자 서버 강제 — 실제 PostgreSQL 모드에서도 동일하게 동작한다", async (t) => {
    const dbName = `hrtest_apptier_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
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
    const server = await startServer({ env: { DATABASE_URL: `${base}/${dbName}` } });
    t.after(() => server.stop());
    const api = (path, options) => fetch(server.baseUrl + path, options);
    const reg = await (await api("/api/companies/register", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ companyName: "결재구간테스트", adminName: "관리자", loginId: "admin", password: "TestPassword123" }),
    })).json();
    assert.equal(reg.ok, true);
    const adminToken = reg.token;
    let d = await getData(api, adminToken);
    const employees = [
      ...d.data.employees,
      { id: 9101, loginId: "mem1", pw: "mem-pw-123456", name: "기안자", role: "member", active: true, dept: "영업", team: "A" },
      { id: 9102, loginId: "lead1", pw: "lead-pw-123456", name: "팀장", role: "leader", active: true, dept: "영업", team: "A" },
      { id: 9103, loginId: "cfo", pw: "cfo-pw-123456", name: "재무임원", role: "director", active: true, dept: "재무", team: "" },
      { id: 9104, loginId: "gone", pw: "gone-pw-123456", name: "퇴직임원", role: "director", active: false, dept: "재무", team: "" },
    ];
    assert.equal((await (await api("/save", auth(adminToken, "POST", { _version: d.version, employees }))).json()).ok, true);
    const mem = await (await api("/login", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ loginId: "mem1", pw: "mem-pw-123456", companyCode: reg.companyCode }) })).json();
    assert.equal(mem.ok, true, JSON.stringify(mem));
    const setTiers = async (amountTiers) => {
      d = await getData(api, adminToken);
      const r = await (await api("/save", auth(adminToken, "POST", {
        _version: d.version, _singletonRevisions: d.data._singletonRevisions,
        approvalChainSettings: { includeLeader: true, includeDirector: true, finalApprovers: [], reminderDays: 2, amountTiers },
      }))).json();
      assert.equal(r.ok, true, JSON.stringify(r));
    };
    let seq = 0;
    const submit = async (approvers, amount) => {
      const id = `pgdoc-${++seq}`;
      const dd = await getData(api, mem.token);
      const r = await (await api("/save", auth(mem.token, "POST", { _version: dd.version, approvalDocs: [{
        id, templateId: "tpl-expense", authorId: String(mem.employee?.id ?? 9101), title: id,
        createdAt: "2099-01-01T00:00:00.000Z", updatedAt: "2099-01-01T00:00:00.000Z", status: "in_progress",
        formData: { amount }, receivers: [], cc: [], attachments: [],
        approvers: approvers.map((a, i) => ({ decidedAt: null, comment: "", label: "결재", ...a, status: i === 0 ? "pending" : "waiting" })),
      }] }))).json();
      const stored = (await getData(api, adminToken)).data.approvalDocs.some(x => x.id === id);
      return { r, stored, id };
    };
    await setTiers([{ minAmount: 1000000, empId: 9103, label: "재무 결재" }]);
    const lead = [{ empId: 9102, label: "팀장" }];
    const miss = await submit(lead, 5000000);
    assert.equal(miss.stored, false);
    assert.equal((miss.r.warnings?.rejectedRecords || []).find(v => v.id === miss.id)?.reason, "APPROVAL_TIER_MISSING", JSON.stringify(miss.r));
    assert.equal((await submit([...lead, { empId: 9103, label: "재무 결재" }], 5000000)).stored, true);
    assert.equal((await submit(lead, 500000)).stored, true);
    await setTiers([{ minAmount: 1000000, empId: 9104, label: "퇴직" }]);
    assert.equal((await submit(lead, 5000000)).stored, true, "퇴직 구간 결재자는 요구하지 않음");
  });
}
