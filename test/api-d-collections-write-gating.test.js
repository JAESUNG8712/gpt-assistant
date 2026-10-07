// HR마인드 벤치마킹 2차 라운드(Epic D, 2026-10-06/07)에서 신설된 5개 ID_KEYED_LIST_FIELDS
// (trainingCourses/trainingEnrollments/wageGarnishments/severanceSettlements/
// socialInsuranceRecords)가 _WRITE_GATED_FIELDS에 전혀 등록되지 않은 채 머지돼, 이 다섯
// 컬렉션에 한해서는 role 검사·값 검증이 서버에 전혀 없었다(2026-10-07 재검증 라운드에서
// 발견 — D1~D5 PR 7건의 CLAUDE.md 소급 기록 작업 중, 코드 조사로 server.js 전체에 이
// 5개 필드명이 단 한 번도 등장하지 않는 것을 확인·재현). 실측 결과:
//   - 인증만 된 member가 직접 POST /save를 호출해 wageGarnishments(급여 압류)·
//     severanceSettlements(퇴직금 정산)·trainingCourses(교육 과정)를 역할·소속과 무관하게
//     임의로 생성·변조할 수 있었다. 전부 admin 전용 화면이 보여주는 "관리자만 할 수 있는"
//     동작을, API를 직접 호출하면 우회할 수 있었던 것(이 프로젝트가 2026-07-20 라운드에서
//     이미 23개 컬렉션에 대해 동일한 클래스의 결함을 찾아 고친 적이 있는데, 그 이후 신설된
//     컬렉션이 같은 체크리스트를 다시 빠뜨린 재발 사례).
//   - trainingEnrollments는 본인(empId) self-service(신청/대기/취소/설문)가 정상 기능이라
//     완전 admin 전용으로 막을 수는 없었음 — ownField 기반 소유권 검사로 "본인 레코드만"
//     허용하되, "완료 처리"(status:"completed")는 실제 출석 확인이 필요한 관리자 전용
//     동작이라 self-promote는 별도로 차단해야 했다(일반 ownField 가드는 "본인 레코드인지"만
//     보고 어떤 상태로 바꾸는지는 제한하지 않으므로).
//
// 이 테스트는 (1) 5개 컬렉션 전부에 대한 member의 신규 레코드 위조가 막히는지, (2) admin의
// 정상 생성/수정은 그대로 동작하는지, (3) trainingEnrollments의 self-service(신청/취소/설문)
// 는 유지되면서 타인 레코드 탈취·self-complete만 막히는지, (4) 값 범위 검증(음수 금액 등)이
// 걸리는지를 JSON 파일 모드와 실제 PostgreSQL 모드 양쪽에서 확인한다.
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

test("D1~D5 신설 컬렉션(5종) — member의 직접 /save 위조가 차단되고 admin/본인 정상 흐름은 유지된다(JSON 파일 모드)", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const api = (path, options) => fetch(server.baseUrl + path, options);

  const admin = await bootstrapAdminAndLogin(server, { loginId: "admin1", pw: "admin-pw-123456", name: "관리자" });
  let d = await getData(api, admin.token);

  const employees = [
    ...d.data.employees,
    { id: "mem1", loginId: "mem1", pw: "mem-pw-123456", name: "일반직원", role: "member", active: true, dept: "영업본부", team: "A팀" },
    { id: "mem2", loginId: "mem2", pw: "mem-pw-123456", name: "일반직원2", role: "member", active: true, dept: "영업본부", team: "A팀" },
  ];
  assert.equal((await (await api("/save", auth(admin.token, "POST", { _version: d.version, employees }))).json()).ok, true);
  const memToken = await login(api, "mem1", "mem-pw-123456");
  const mem2Token = await login(api, "mem2", "mem-pw-123456");

  await t.test("admin의 정상 생성은 5개 컬렉션 전부 그대로 저장된다", async () => {
    d = await getData(api, admin.token);
    const r = await (await api("/save", auth(admin.token, "POST", {
      _version: d.version,
      trainingCourses: [{ id: "c1", title: "리더십 과정", status: "open", capacity: 2, cost: 100000, startDate: "2026-11-01", endDate: "2026-11-02" }],
      wageGarnishments: [{ id: "wg1", empId: "mem1", empName: "일반직원", type: "fixed", amount: 300000, status: "active" }],
      severanceSettlements: [{ id: "sev1", empId: "mem1", empName: "일반직원", type: "final", severanceAmount: 5000000, settlementDate: "2026-10-07" }],
      socialInsuranceRecords: [{ id: "sir1", empId: "mem1", empName: "일반직원", type: "acquisition", insuranceTypes: ["pension", "health"], effectiveDate: "2026-01-01" }],
    }))).json();
    assert.equal(r.ok, true);
    d = await getData(api, admin.token);
    assert.equal(d.data.trainingCourses.length, 1);
    assert.equal(d.data.wageGarnishments[0].amount, 300000);
    assert.equal(d.data.severanceSettlements[0].severanceAmount, 5000000);
    assert.equal(d.data.socialInsuranceRecords[0].type, "acquisition");
  });

  await t.test("member는 wageGarnishments/severanceSettlements/trainingCourses/socialInsuranceRecords를 위조할 수 없다", async () => {
    d = await getData(api, memToken);
    await api("/save", auth(memToken, "POST", {
      _version: d.version,
      wageGarnishments: [...(d.data.wageGarnishments || []), { id: "wg-forged", empId: "admin1-victim", amount: 999999999, type: "fixed", status: "active", reason: "FORGED" }],
      severanceSettlements: [...(d.data.severanceSettlements || []), { id: "sev-forged", empId: "mem2", type: "final", severanceAmount: 500000000 }],
      trainingCourses: [...(d.data.trainingCourses || []), { id: "course-forged", title: "가짜 과정" }],
      socialInsuranceRecords: [...(d.data.socialInsuranceRecords || []), { id: "sir-forged", empId: "mem2", type: "acquisition", insuranceTypes: ["pension"] }],
    }));
    d = await getData(api, admin.token);
    assert.equal(d.data.wageGarnishments.some(w => w.id === "wg-forged"), false);
    assert.equal(d.data.severanceSettlements.some(s => s.id === "sev-forged"), false);
    assert.equal(d.data.trainingCourses.some(c => c.id === "course-forged"), false);
    assert.equal(d.data.socialInsuranceRecords.some(s => s.id === "sir-forged"), false);
  });

  await t.test("member는 자기 명의(empId)로 교육과정을 신청·취소·설문제출할 수 있다(self-service 유지)", async () => {
    d = await getData(api, memToken);
    let r = await (await api("/save", auth(memToken, "POST", { _version: d.version, trainingEnrollments: [{ id: "e1", courseId: "c1", empId: "mem1", empName: "일반직원", status: "applied" }] }))).json();
    assert.equal(r.ok, true);
    d = await getData(api, admin.token);
    assert.equal(d.data.trainingEnrollments.find(e => e.id === "e1").status, "applied");

    d = await getData(api, memToken);
    const own = d.data.trainingEnrollments.find(e => e.id === "e1");
    r = await (await api("/save", auth(memToken, "POST", { _version: d.version, trainingEnrollments: [{ ...own, surveyResponse: { satisfaction: 5, comment: "좋았습니다" } }] }))).json();
    assert.equal(r.ok, true);
    d = await getData(api, admin.token);
    assert.equal(d.data.trainingEnrollments.find(e => e.id === "e1").surveyResponse.satisfaction, 5);

    d = await getData(api, memToken);
    const own2 = d.data.trainingEnrollments.find(e => e.id === "e1");
    r = await (await api("/save", auth(memToken, "POST", { _version: d.version, trainingEnrollments: [{ ...own2, status: "canceled" }] }))).json();
    assert.equal(r.ok, true);
    d = await getData(api, admin.token);
    assert.equal(d.data.trainingEnrollments.find(e => e.id === "e1").status, "canceled");
  });

  await t.test("member는 타인 명의로 신청을 위조하거나 타인의 기존 신청을 변조할 수 없다", async () => {
    d = await getData(api, memToken);
    await api("/save", auth(memToken, "POST", { _version: d.version, trainingEnrollments: [...d.data.trainingEnrollments, { id: "e2-forged", courseId: "c1", empId: "mem2", empName: "일반직원2(위조)", status: "applied" }] }));
    d = await getData(api, admin.token);
    assert.equal(d.data.trainingEnrollments.some(e => e.id === "e2-forged"), false);

    // mem2가 mem1의 기존 레코드(e1)를 자기 명의로 바꿔치기 시도 — 소유자 필드 변경 자체가 막힌다.
    d = await getData(api, mem2Token);
    const victim = d.data.trainingEnrollments.find(e => e.id === "e1");
    await api("/save", auth(mem2Token, "POST", { _version: d.version, trainingEnrollments: [{ ...victim, empId: "mem2", status: "completed" }] }));
    d = await getData(api, admin.token);
    const after = d.data.trainingEnrollments.find(e => e.id === "e1");
    assert.equal(after.empId, "mem1");
    assert.equal(after.status, "canceled");
  });

  await t.test("member는 자기 신청을 직접 completed로 승격시킬 수 없다(관리자의 '완료 처리'만 가능)", async () => {
    d = await getData(api, mem2Token);
    await api("/save", auth(mem2Token, "POST", { _version: d.version, trainingEnrollments: [...d.data.trainingEnrollments, { id: "e3", courseId: "c1", empId: "mem2", empName: "일반직원2", status: "completed" }] }));
    d = await getData(api, admin.token);
    assert.equal(d.data.trainingEnrollments.some(e => e.id === "e3"), false);
  });

  await t.test("admin은 completed로 전환할 수 있다(관리자 오버라이드 유지)", async () => {
    d = await getData(api, admin.token);
    const target = d.data.trainingEnrollments.find(e => e.id === "e1");
    const r = await (await api("/save", auth(admin.token, "POST", { _version: d.version, trainingEnrollments: [{ ...target, status: "completed" }] }))).json();
    assert.equal(r.ok, true);
    d = await getData(api, admin.token);
    assert.equal(d.data.trainingEnrollments.find(e => e.id === "e1").status, "completed");
  });

  await t.test("값 범위 검증 — admin이라도 음수 압류금액·범위 밖 날짜는 거부된다", async () => {
    d = await getData(api, admin.token);
    await api("/save", auth(admin.token, "POST", { _version: d.version, wageGarnishments: [...d.data.wageGarnishments, { id: "wg-bad", empId: "mem1", type: "fixed", amount: -500, status: "active" }] }));
    d = await getData(api, admin.token);
    assert.equal(d.data.wageGarnishments.some(w => w.id === "wg-bad"), false);
  });
});

const ADMIN_DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!ADMIN_DATABASE_URL) {
  test("D1~D5 신설 컬렉션 쓰기 게이팅 — 실제 PostgreSQL (skipped: DATABASE_URL/TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  const { Client } = require("pg");

  test("D1~D5 신설 컬렉션 쓰기 게이팅 — 실제 PostgreSQL 모드에서도 동일하게 차단된다", async (t) => {
    const dbName = `hrtest_dcollgate_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
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

    const base = ADMIN_DATABASE_URL.replace(/\/[^/]*(\?.*)?$/, "");
    const server = await startServer({ env: { DATABASE_URL: `${base}/${dbName}` } });
    t.after(() => server.stop());
    const api = (path, options) => fetch(server.baseUrl + path, options);

    const reg = await (await api("/api/companies/register", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ companyName: "D컬렉션게이팅테스트", adminName: "관리자", loginId: "admin", password: "TestPassword123" }),
    })).json();
    assert.equal(reg.ok, true);
    const adminToken = reg.token;

    let d = await getData(api, adminToken);
    const employees = [...d.data.employees, { id: "mem1", loginId: "mem1", pw: "mem-pw-123456", name: "일반직원", role: "member", active: true, dept: "영업본부", team: "A팀" }];
    assert.equal((await (await api("/save", auth(adminToken, "POST", { _version: d.version, employees }))).json()).ok, true);
    const memToken = await login(api, "mem1", "mem-pw-123456", reg.companyCode);

    await t.test("admin이 생성한 severanceSettlements/wageGarnishments는 그대로 저장된다", async () => {
      d = await getData(api, adminToken);
      const r = await (await api("/save", auth(adminToken, "POST", {
        _version: d.version,
        wageGarnishments: [{ id: "wg1", empId: "mem1", empName: "일반직원", type: "fixed", amount: 300000, status: "active" }],
        severanceSettlements: [{ id: "sev1", empId: "mem1", empName: "일반직원", type: "final", severanceAmount: 5000000, settlementDate: "2026-10-07" }],
      }))).json();
      assert.equal(r.ok, true);
      d = await getData(api, adminToken);
      assert.equal(d.data.wageGarnishments[0].amount, 300000);
      assert.equal(d.data.severanceSettlements[0].severanceAmount, 5000000);
    });

    await t.test("member는 실제 PostgreSQL 모드에서도 severanceSettlements/wageGarnishments를 위조할 수 없다", async () => {
      d = await getData(api, memToken);
      await api("/save", auth(memToken, "POST", {
        _version: d.version,
        wageGarnishments: [...(d.data.wageGarnishments || []), { id: "wg-forged", empId: "mem1", amount: 999999999, type: "fixed", status: "active" }],
        severanceSettlements: [...(d.data.severanceSettlements || []), { id: "sev-forged", empId: "mem1", type: "final", severanceAmount: 500000000 }],
      }));
      d = await getData(api, adminToken);
      assert.equal(d.data.wageGarnishments.some(w => w.id === "wg-forged"), false);
      assert.equal(d.data.severanceSettlements.some(s => s.id === "sev-forged"), false);
    });

    await t.test("member는 실제 PostgreSQL 모드에서도 자기 명의로는 교육 신청을 할 수 있다", async () => {
      d = await getData(api, adminToken);
      await (await api("/save", auth(adminToken, "POST", { _version: d.version, trainingCourses: [{ id: "c1", title: "과정", status: "open" }] }))).json();
      d = await getData(api, memToken);
      const r = await (await api("/save", auth(memToken, "POST", { _version: d.version, trainingEnrollments: [{ id: "e1", courseId: "c1", empId: "mem1", empName: "일반직원", status: "applied" }] }))).json();
      assert.equal(r.ok, true);
      d = await getData(api, adminToken);
      assert.equal(d.data.trainingEnrollments.find(e => e.id === "e1").empId, "mem1");
    });
  });
}
