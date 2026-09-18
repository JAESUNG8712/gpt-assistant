// 복리후생(경조금/학자금) 신청이 결재 승인 완료되면 payrollAdjustments(급여 조정)에
// 자동 반영되는데(public/index.html의 _applyWelfareApproval), 그 결재선의 "마지막
// 결재자"는 대개 팀장·사업부장(non-admin)이다 — payrollAdjustments는 admin 전용 필드라
// (_WRITE_GATED_FIELDS.payrollAdjustments={roles:["admin"]}), 이 정당한 파생 레코드가
// 서버에 저장될 때마다 조용히 드롭되고 있었다(2026-09-18 발견, PR#71 복리후생 신청 기능
// 감사). "급여 종합 관리" 화면을 admin이 열어야만 _syncApprovedWelfareAdjustments()가
// 뒤늦게 복구해주는 안전망은 있었지만, 아무도 그 화면을 제때 열지 않으면 그 달 급여에
// 영구히 반영되지 않는다. 승인된 결재문서 내용과 완전히 일치하는 신규 레코드만(위조 불가)
// role과 무관하게 통과시키는 서버측 예외(_welfareAdjustmentMatchesApprovedDoc)를 검증한다.
//
// mkdtemp의 DATA_FILE, 랜덤 PORT, child process `node server.js`만 사용 — 실제 DB나
// 운영 데이터 파일은 이 테스트가 존재하는지조차 모른다.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer, bootstrapAdminAndLogin } = require("./support/start-server");

async function login(api, loginId, pw, companyCode) {
  const r = await (await api("/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ loginId, pw, ...(companyCode ? { companyCode } : {}) }),
  })).json();
  assert.equal(r.ok, true, `${loginId} 로그인 실패: ${JSON.stringify(r)}`);
  return r.token;
}
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

test("복리후생(경조금) 신청이 non-admin 결재로 승인 완료되면 payrollAdjustments가 실제로 저장된다", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const api = (path, options) => fetch(server.baseUrl + path, options);

  const boot = await bootstrapAdminAndLogin(server, { loginId: "admin", pw: "admin-test-pw-1", name: "관리자" });
  const adminToken = boot.token;
  let d = await getData(api, adminToken);

  const employees = [
    ...d.data.employees,
    { id: "welf-dir-1", loginId: "welf-dir-1", pw: "welf-dir-pw-1", name: "사업부장(결재자)", role: "director", active: true, dept: "개발본부" },
    { id: "welf-mem-1", loginId: "welf-mem-1", pw: "welf-mem-pw-1", name: "신청자", role: "member", active: true, dept: "개발본부", team: "A팀" },
  ];
  const approvedAt = "2027-03-05T00:00:00.000Z";
  const pendingDoc = {
    id: "welf-doc-1", templateId: "tpl-welfare-condolence", title: "경조금 신청: 본인 결혼 (500,000원)",
    authorId: "welf-mem-1", status: "pending", createdAt: "2027-03-01T00:00:00.000Z", updatedAt: "2027-03-01T00:00:00.000Z",
    formData: { welfarePolicyId: "marriage", requestedAmount: 500000, policyName: "본인 결혼", payrollLinked: true },
    approvers: [{ empId: "welf-dir-1", label: "사업부장", status: "pending", decidedAt: null, comment: "" }],
  };
  let r = await api("/save", auth(adminToken, "POST", { _version: d.version, employees, approvalDocs: [pendingDoc] }));
  assert.equal(r.status, 200);

  const dirToken = await login(api, "welf-dir-1", "welf-dir-pw-1");

  await t.test("승인 완료 시점에 함께 전송된, 문서 내용과 정확히 일치하는 신규 레코드는 role과 무관하게 저장된다", async () => {
    d = await getData(api, dirToken);
    const doc = d.data.approvalDocs.find(x => x.id === "welf-doc-1");
    const approvedDoc = {
      ...doc, status: "approved", approvedAt,
      approvers: doc.approvers.map(a => ({ ...a, status: "approved", decidedAt: approvedAt, comment: "승인" })),
      updatedAt: approvedAt,
    };
    const adjustment = {
      id: "payadj-welf-doc-1", empId: "welf-mem-1", year: 2027, month: 3, category: "경조사비",
      amount: 500000, note: "본인 결혼 · 결재 welf-doc-1", sourceDocId: "welf-doc-1",
      createdAt: approvedAt, updatedAt: approvedAt,
    };
    const r = await api("/save", auth(dirToken, "POST", {
      _version: d.version, approvalDocs: [approvedDoc], payrollAdjustments: [adjustment],
    }));
    assert.equal(r.status, 200);

    d = await getData(api, adminToken); // payrollAdjustments는 본인 것만 보이므로 admin으로 재확인
    const doc2 = d.data.approvalDocs.find(x => x.id === "welf-doc-1");
    assert.equal(doc2.status, "approved");
    const saved = d.data.payrollAdjustments.find(a => a.sourceDocId === "welf-doc-1");
    assert.ok(saved, "승인된 복리후생 신청의 payrollAdjustments 레코드가 저장돼야 한다");
    assert.equal(saved.amount, 500000);
    assert.equal(saved.empId, "welf-mem-1");
    assert.equal(saved.category, "경조사비");
  });

  await t.test("금액이 승인 문서와 다른(위조) 신규 레코드는 여전히 드롭된다", async () => {
    d = await getData(api, dirToken);
    const adjustment = {
      id: "payadj-welf-doc-1-forged", empId: "welf-mem-1", year: 2027, month: 3, category: "경조사비",
      amount: 99000000, sourceDocId: "welf-doc-1", createdAt: approvedAt, updatedAt: new Date().toISOString(),
    };
    const r = await api("/save", auth(dirToken, "POST", { _version: d.version, payrollAdjustments: [adjustment] }));
    assert.equal(r.status, 200);
    d = await getData(api, adminToken);
    assert.equal(d.data.payrollAdjustments.find(a => a.id === "payadj-welf-doc-1-forged"), undefined);
  });

  await t.test("근거 문서가 아예 없는(sourceDocId 없음) 신규 레코드는 non-admin이 만들 수 없다(기존 role 게이팅 유지)", async () => {
    d = await getData(api, dirToken);
    const adjustment = { id: "payadj-unrelated-1", empId: "welf-mem-1", year: 2027, month: 3, category: "인센티브", amount: 1000000, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    const r = await api("/save", auth(dirToken, "POST", { _version: d.version, payrollAdjustments: [adjustment] }));
    assert.equal(r.status, 200);
    d = await getData(api, adminToken);
    assert.equal(d.data.payrollAdjustments.find(a => a.id === "payadj-unrelated-1"), undefined);
  });

  await t.test("이미 저장된 payrollAdjustments 레코드를 non-admin이 수정하는 것은 여전히 되돌려진다(!stored 예외에 해당하지 않음)", async () => {
    d = await getData(api, dirToken);
    const existing = d.data.payrollAdjustments.find(a => a.id === "payadj-welf-doc-1");
    const tampered = { ...existing, amount: 1, updatedAt: new Date().toISOString() };
    const r = await api("/save", auth(dirToken, "POST", { _version: d.version, payrollAdjustments: [tampered] }));
    assert.equal(r.status, 200);
    d = await getData(api, adminToken);
    const saved = d.data.payrollAdjustments.find(a => a.id === "payadj-welf-doc-1");
    assert.equal(saved.amount, 500000, "기존 레코드 수정은 admin 전용 게이팅이 그대로 적용돼야 한다");
  });

  await t.test("admin은 여전히 임의의 payrollAdjustments 레코드를 직접 만들 수 있다(회귀 확인)", async () => {
    d = await getData(api, adminToken);
    const bonus = { id: "payadj-admin-bonus-1", empId: "welf-mem-1", year: 2027, month: 4, category: "인센티브", amount: 2000000, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    const r = await api("/save", auth(adminToken, "POST", { _version: d.version, payrollAdjustments: [bonus] }));
    assert.equal(r.status, 200);
    d = await getData(api, adminToken);
    assert.ok(d.data.payrollAdjustments.find(a => a.id === "payadj-admin-bonus-1"));
  });
});

const ADMIN_DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!ADMIN_DATABASE_URL) {
  test("복리후생 급여연동 — Postgres 모드 (skipped: DATABASE_URL/TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  const { Client } = require("pg");

  test("복리후생 신청 승인 시 payrollAdjustments 연동이 실제 PostgreSQL(운영 모드)에서도 정상 동작한다", async (t) => {
    const dbName = `hrtest_welfpay_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
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
      companyName: "복리후생연동테스트회사", adminName: "관리자", loginId: "admin_wp", password: "AdminPassw0rd1",
    }))).json();
    assert.equal(reg.ok, true);
    const adminToken = reg.token;
    const companyCode = reg.companyCode;

    let d = await getData(api, adminToken);
    const employees = [
      ...d.data.employees,
      { id: "pg-welf-dir-1", loginId: "pg-welf-dir-1", pw: "pg-welf-dir-pw-1", name: "사업부장(결재자)", role: "director", active: true, dept: "개발본부" },
      { id: "pg-welf-mem-1", loginId: "pg-welf-mem-1", pw: "pg-welf-mem-pw-1", name: "신청자", role: "member", active: true, dept: "개발본부", team: "A팀" },
    ];
    const approvedAt = "2027-03-05T00:00:00.000Z";
    const pendingDoc = {
      id: "pg-welf-doc-1", templateId: "tpl-welfare-tuition", title: "학자금 신청",
      authorId: "pg-welf-mem-1", status: "pending", createdAt: "2027-03-01T00:00:00.000Z", updatedAt: "2027-03-01T00:00:00.000Z",
      formData: { welfarePolicyId: "university", requestedAmount: 1500000, policyName: "대학교 학자금", payrollLinked: true },
      approvers: [{ empId: "pg-welf-dir-1", label: "사업부장", status: "pending", decidedAt: null, comment: "" }],
    };
    let r = await api("/save", auth(adminToken, "POST", { _version: d.version, employees, approvalDocs: [pendingDoc] }));
    assert.equal(r.status, 200);

    const dirToken = await login(api, "pg-welf-dir-1", "pg-welf-dir-pw-1", companyCode);
    d = await getData(api, dirToken);
    const doc = d.data.approvalDocs.find(x => x.id === "pg-welf-doc-1");
    const approvedDoc = {
      ...doc, status: "approved", approvedAt,
      approvers: doc.approvers.map(a => ({ ...a, status: "approved", decidedAt: approvedAt, comment: "승인" })),
      updatedAt: approvedAt,
    };
    const adjustment = {
      id: "pg-payadj-welf-doc-1", empId: "pg-welf-mem-1", year: 2027, month: 3, category: "학자금",
      amount: 1500000, sourceDocId: "pg-welf-doc-1", createdAt: approvedAt, updatedAt: approvedAt,
    };
    r = await api("/save", auth(dirToken, "POST", { _version: d.version, approvalDocs: [approvedDoc], payrollAdjustments: [adjustment] }));
    assert.equal(r.status, 200);

    d = await getData(api, adminToken);
    const saved = d.data.payrollAdjustments.find(a => a.sourceDocId === "pg-welf-doc-1");
    assert.ok(saved, "Postgres 모드에서도 승인된 복리후생 신청의 payrollAdjustments가 저장돼야 함");
    assert.equal(saved.amount, 1500000);
    assert.equal(saved.category, "학자금");
  });
}
