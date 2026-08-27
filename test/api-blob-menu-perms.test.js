// 구조적 한계 #1(2026-08-21) — REST API 화면(requirePage)과 달리, 범용 blob 동기화
// (POST /save)를 타는 컬렉션(kpiEntries/employees/compGradeResults 등)은 role만 검사하고
// menuPerms(개인별로 끈 메뉴)는 전혀 확인하지 않고 있었다 — 관리자가 어떤 팀장의 "1차 평가"
// 메뉴를 개인적으로 꺼도, 그 팀장이 /save를 직접 호출하면 role(leader)만 맞으면 그대로
// 통과됐다. 이 파일은 그 확장(_menuPermsAllow가 _sanitizeKpiEntry/_writeGateAllowed에
// 통합된 것)과, 같은 작업 중 발견한 인접 결함들(employees.gradeResults가 전혀 게이팅되지
// 않고 있던 것, compGradeResults도 마찬가지, 그리고 다른 세션이 추가한
// preserveServerOwnedStateForNonAdmin()이 director의 정당한 타인 등급 조정을 항상 조용히
// 되돌리던 회귀)을 검증한다.
//
// mkdtemp의 DATA_FILE, 랜덤 PORT, child process `node server.js`만 사용 — 실제 DB나
// 운영 데이터 파일은 이 테스트가 존재하는지조차 모른다.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer, bootstrapAdminAndLogin } = require("./support/start-server");

async function login(api, loginId, pw) {
  const r = await (await api("/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ loginId, pw }),
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

test("blob 동기화(/save) 컬렉션의 menuPerms/권한 확장 — kpiEntries·employees.gradeResults·compGradeResults", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const api = (path, options) => fetch(server.baseUrl + path, options);

  const boot = await bootstrapAdminAndLogin(server, { loginId: "admin", pw: "admin-test-pw-1", name: "관리자" });
  const adminToken = boot.token;
  const initial = await getData(api, adminToken);

  const employees = [
    ...initial.data.employees,
    { id: "leaderA", loginId: "leaderA", pw: "leaderA-pw-1", name: "팀장A(제한)", role: "leader", active: true, dept: "개발본부", team: "A팀", menuPerms: { "first-eval": false } },
    { id: "leaderB", loginId: "leaderB", pw: "leaderB-pw-1", name: "팀장B(정상)", role: "leader", active: true, dept: "개발본부", team: "B팀", menuPerms: {} },
    { id: "dir1", loginId: "dir1", pw: "dir1-pw-1", name: "사업부장1(제한)", role: "director", active: true, dept: "개발본부", menuPerms: { "second-eval": false, "grade-view": false } },
    // dir2: 개발본부와 무관한 다른 부서(영업본부) — "타 부서라 차단" 시나리오 전용.
    { id: "dir2", loginId: "dir2", pw: "dir2-pw-1", name: "사업부장2(무관부서·정상권한)", role: "director", active: true, dept: "영업본부", menuPerms: {} },
    // dir3: memberB/kpiB와 같은 부서(개발본부)이면서 menuPerms 제한이 없는 대조군 —
    // dir1은 second-eval이 꺼져 있어 "정상 최종승인" 대조군으로 쓸 수 없어 별도로 둔다.
    { id: "dir3", loginId: "dir3", pw: "dir3-pw-1", name: "사업부장3(개발본부·정상)", role: "director", active: true, dept: "개발본부", menuPerms: {} },
    { id: "memberA", loginId: "memberA", pw: "memberA-pw-1", name: "팀원A(kpi화면제한)", role: "member", active: true, dept: "개발본부", team: "A팀", gradeResults: {}, menuPerms: { kpi: false, "kpi-results": false } },
    { id: "memberB", loginId: "memberB", pw: "memberB-pw-1", name: "팀원B(정상)", role: "member", active: true, dept: "개발본부", team: "B팀", menuPerms: {} },
  ];
  const kpiEntries = [
    { id: "kpiA", userId: "memberA", year: 2026, title: "목표A-원본", weight: 30, firstStatus: "pending", finalStatus: "pending" },
    { id: "kpiB", userId: "memberB", year: 2026, title: "목표B-원본", weight: 30, firstStatus: "pending", finalStatus: "pending" },
  ];
  const seed = await api("/save", auth(adminToken, "POST", { _version: initial.version, employees, kpiEntries }));
  assert.equal(seed.status, 200);

  const leaderAToken = await login(api, "leaderA", "leaderA-pw-1");
  const leaderBToken = await login(api, "leaderB", "leaderB-pw-1");
  const dir1Token = await login(api, "dir1", "dir1-pw-1");
  const dir2Token = await login(api, "dir2", "dir2-pw-1");
  const dir3Token = await login(api, "dir3", "dir3-pw-1");
  const memberAToken = await login(api, "memberA", "memberA-pw-1");
  const memberBToken = await login(api, "memberB", "memberB-pw-1");

  async function kpiOf(id) {
    const d = await getData(api, adminToken);
    return d.data.kpiEntries.find(k => k.id === id);
  }
  async function saveKpi(token, patch) {
    const d = await getData(api, token);
    const kpiEntries = d.data.kpiEntries.map(k => k.id === patch.id ? { ...k, ...patch } : k);
    return api("/save", auth(token, "POST", { _version: d.version, kpiEntries }));
  }

  await t.test("first-eval을 개인적으로 끈 팀장은 role상 자격이 있어도 1차승인이 되돌려진다", async () => {
    const r = await saveKpi(leaderAToken, { id: "kpiA", firstStatus: "approved" });
    assert.equal(r.status, 200);
    const kpi = await kpiOf("kpiA");
    assert.equal(kpi.firstStatus, "pending");
  });

  await t.test("제한 없는 팀장은 같은 조건에서 정상 승인된다(대조군)", async () => {
    const r = await saveKpi(leaderBToken, { id: "kpiB", firstStatus: "approved" });
    assert.equal(r.status, 200);
    const kpi = await kpiOf("kpiB");
    assert.equal(kpi.firstStatus, "approved");
  });

  await t.test("second-eval을 개인적으로 끈 사업부장은 최종승인이 되돌려진다", async () => {
    const r = await saveKpi(dir1Token, { id: "kpiA", finalStatus: "approved" });
    assert.equal(r.status, 200);
    const kpi = await kpiOf("kpiA");
    assert.equal(kpi.finalStatus, "pending");
  });

  await t.test("제한 없는 사업부장은 최종승인이 정상 반영된다(대조군)", async () => {
    const r = await saveKpi(dir3Token, { id: "kpiB", finalStatus: "approved" });
    assert.equal(r.status, 200);
    const kpi = await kpiOf("kpiB");
    assert.equal(kpi.finalStatus, "approved");
  });

  await t.test("kpi/kpi-results 화면을 모두 끈 사원은 기존 목표의 일반 필드(제목)도 수정할 수 없다", async () => {
    const r = await saveKpi(memberAToken, { id: "kpiA", title: "위조된제목" });
    assert.equal(r.status, 200);
    const kpi = await kpiOf("kpiA");
    assert.equal(kpi.title, "목표A-원본");
  });

  await t.test("kpi/kpi-results 화면을 모두 끈 사원은 신규 목표를 새로 만들 수 없다(드롭)", async () => {
    const d = await getData(api, memberAToken);
    const kpiEntries = [...d.data.kpiEntries, { id: "kpiA-new", userId: "memberA", year: 2026, title: "새목표", weight: 20 }];
    const r = await api("/save", auth(memberAToken, "POST", { _version: d.version, kpiEntries }));
    assert.equal(r.status, 200);
    const found = await kpiOf("kpiA-new");
    assert.equal(found, undefined);
  });

  await t.test("제한 없는 사원은 신규 목표를 정상 등록할 수 있다(대조군)", async () => {
    const d = await getData(api, memberBToken);
    const kpiEntries = [...d.data.kpiEntries, { id: "kpiB-new", userId: "memberB", year: 2026, title: "새목표B", weight: 20 }];
    const r = await api("/save", auth(memberBToken, "POST", { _version: d.version, kpiEntries }));
    assert.equal(r.status, 200);
    const found = await kpiOf("kpiB-new");
    assert.equal(found.title, "새목표B");
  });

  async function empOf(id) {
    const d = await getData(api, adminToken);
    return d.data.employees.find(e => e.id === id);
  }
  async function saveEmp(token, patch) {
    const d = await getData(api, token);
    const employees = d.data.employees.map(e => e.id === patch.id ? { ...e, ...patch, updatedAt: new Date().toISOString() } : e);
    return api("/save", auth(token, "POST", { _version: d.version, employees }));
  }

  await t.test("사원 본인은 자기 KPI 최종등급(gradeResults)을 직접 조작할 수 없다", async () => {
    const r = await saveEmp(memberAToken, { id: "memberA", gradeResults: { 2026: { grade: "S" } } });
    assert.equal(r.status, 200);
    const emp = await empOf("memberA");
    assert.deepEqual(emp.gradeResults || {}, {});
  });

  await t.test("무관한 부서의 사업부장은 타 부서 직원의 등급을 조정할 수 없다", async () => {
    const r = await saveEmp(dir2Token, { id: "memberA", gradeResults: { 2026: { grade: "S" } } });
    assert.equal(r.status, 200);
    const emp = await empOf("memberA");
    assert.deepEqual(emp.gradeResults || {}, {});
  });

  await t.test("같은 부서 사업부장은 정상적으로 등급을 조정할 수 있다(director의 유일한 정당한 타인 레코드 쓰기 — preserveServerOwnedStateForNonAdmin 회귀 확인)", async () => {
    const r = await saveEmp(dir1Token, { id: "memberA", gradeResults: { 2026: { grade: "A" } } });
    assert.equal(r.status, 200);
    const emp = await empOf("memberA");
    assert.equal(emp.gradeResults?.["2026"]?.grade, "A");
  });

  await t.test("사업부장이 등급 조정 시 대상 직원의 다른 필드(이름 등)는 여전히 위조할 수 없다", async () => {
    const r = await saveEmp(dir1Token, { id: "memberA", name: "이름위조시도", gradeResults: { 2026: { grade: "B" } } });
    assert.equal(r.status, 200);
    const emp = await empOf("memberA");
    assert.equal(emp.name, "팀원A(kpi화면제한)");
    assert.equal(emp.gradeResults?.["2026"]?.grade, "B");
  });

  // 2026-08-27 감사에서 발견: preserveServerOwnedStateForNonAdmin()이 director의 정당한
  // gradeResults 조정을 통과시키도록 위 회귀(2026-08-24)를 고칠 때, 그 조정 대상 레코드를
  // stored(요청 시작 시점 DB 값) 기준으로 `{...stored, gradeResults, updatedAt}`만 다시
  // 만드는 방식을 썼는데, `_applyRecordCas()`가 조금 앞서 계산해 candidate._rev에 실어둔
  // CAS revision 값은 옮기지 않아 저장된 _rev가 영원히 옛 값에 머물렀다 — 그러면 이후
  // 요청이 여전히 그 옛 rev로 CAS를 통과해, 두 director가 같은 팀원의 등급을 거의 동시에
  // 조정하면 두 번째 저장이 409 없이 첫 번째 저장을 조용히 덮어쓴다(CAS가 막으려던 바로
  // 그 lost-update가 이 함수를 통과하는 유일한 non-admin 타인쓰기 경로에서만 무력화돼
  // 있었다). 이 테스트는 CAS를 실제로 켠 상태(_recordCasVersion:1)로 그 경합을 재현한다.
  await t.test("director의 gradeResults 조정도 CAS(_recordCasVersion:1)로 보호된다 — 두 사업부장이 거의 동시에 조정하면 두 번째가 409로 거부된다", async () => {
    const base = await getData(api, dir1Token);
    const memberBBase = base.data.employees.find(e => e.id === "memberB");

    const dir3Save = await api("/save", auth(dir1Token, "POST", {
      _version: base.version, _recordCasVersion: 1, _changedSingletonKeys: [],
      data: { employees: [{ ...memberBBase, gradeResults: { 2026: { grade: "A" } }, updatedAt: "2098-02-01T00:00:00.000Z" }] },
    }));
    assert.equal(dir3Save.status, 200, `첫 저장 실패: ${JSON.stringify(await dir3Save.json())}`);

    const afterFirst = await empOf("memberB");
    assert.equal(afterFirst.gradeResults?.["2026"]?.grade, "A");
    assert.ok(Number(afterFirst._rev) > (Number(memberBBase._rev) || 0), "CAS가 계산한 _rev 증가분이 저장에 반영돼야 한다");

    // dir3(같은 부서 사업부장)이 memberBBase 시점의 stale 스냅샷으로(방금 dir1의 저장을
    // 전혀 못 본 채) 경합 조정을 시도한다 — 수정 전에는 _rev가 절대 증가하지 않아 이
    // 저장이 409 없이 그대로 통과해 dir1의 "A" 조정을 조용히 "B"로 덮어썼다.
    const raceSave = await api("/save", auth(dir3Token, "POST", {
      _version: base.version, _recordCasVersion: 1, _changedSingletonKeys: [],
      data: { employees: [{ ...memberBBase, gradeResults: { 2026: { grade: "B" } }, updatedAt: "2098-02-02T00:00:00.000Z" }] },
    }));
    const raceBody = await raceSave.json();
    assert.equal(raceSave.status, 409, `stale CAS로 두 번째 조정이 409 없이 통과됨: ${JSON.stringify(raceBody)}`);
    assert.equal(raceBody.code, "RECORD_REVISION_CONFLICT");

    const finalEmp = await empOf("memberB");
    assert.equal(finalEmp.gradeResults?.["2026"]?.grade, "A", "dir1의 정상 저장이 dir3의 stale 저장에 덮어써지면 안 된다");
  });

  await t.test("사원 본인은 다면평가 최종등급(compGradeResults)도 직접 조작할 수 없다", async () => {
    const d = await getData(api, memberAToken);
    const r = await api("/save", auth(memberAToken, "POST", {
      _version: d.version, compGradeResults: { memberA: { 2026: { grade: "S" } } },
    }));
    assert.equal(r.status, 200);
    const check = await getData(api, adminToken);
    assert.deepEqual((check.data.compGradeResults || {}).memberA || {}, {});
  });

  await t.test("관리자는 compGradeResults를 정상적으로 기록할 수 있다(대조군)", async () => {
    const d = await getData(api, adminToken);
    const r = await api("/save", auth(adminToken, "POST", {
      _version: d.version, compGradeResults: { memberA: { 2026: { grade: "A", computedAt: new Date().toISOString() } } },
    }));
    assert.equal(r.status, 200);
    const check = await getData(api, adminToken);
    assert.equal(check.data.compGradeResults?.memberA?.["2026"]?.grade, "A");
  });

  await t.test("_WRITE_GATED_FIELDS의 pageIds — core-talent 메뉴를 끈 관리자는 coreTalentPool을 쓸 수 없다", async () => {
    // 대상 admin 계정을 별도로 만들어 admin1의 menuPerms만 제한한다.
    const d0 = await getData(api, adminToken);
    const employees2 = [
      ...d0.data.employees,
      { id: "admin2", loginId: "admin2", pw: "admin2-pw-1", name: "관리자2(제한)", role: "admin", active: true, menuPerms: { "core-talent": false } },
    ];
    await api("/save", auth(adminToken, "POST", { _version: d0.version, employees: employees2 }));
    const admin2Token = await login(api, "admin2", "admin2-pw-1");

    const d = await getData(api, admin2Token);
    const coreTalentPool = [...(d.data.coreTalentPool || []), { id: "ct1", empId: "memberB", note: "테스트" }];
    const r = await api("/save", auth(admin2Token, "POST", { _version: d.version, coreTalentPool }));
    assert.equal(r.status, 200);
    const check = await getData(api, adminToken);
    assert.equal((check.data.coreTalentPool || []).some(c => c.id === "ct1"), false);
  });

  await t.test("_WRITE_GATED_FIELDS의 pageIds 배열(gradeAdjustHistory) — 하나라도 켜져 있으면 허용, 전부 꺼지면 차단", async () => {
    // dir1은 menuPerms에 grade-view만 false로 설정됨(comp-grade-view는 미설정) — "any allows"라
    // 이 상태에서는 여전히 허용돼야 한다.
    let d = await getData(api, dir1Token);
    let gradeAdjustHistory = [...(d.data.gradeAdjustHistory || []), { id: "gah1", type: "kpi", empId: "memberA", year: 2026, dept: "개발본부", oldGrade: "-", newGrade: "A" }];
    let r = await api("/save", auth(dir1Token, "POST", { _version: d.version, gradeAdjustHistory }));
    assert.equal(r.status, 200);
    let check = await getData(api, adminToken);
    assert.equal((check.data.gradeAdjustHistory || []).some(x => x.id === "gah1"), true);

    // comp-grade-view도 마저 끈 뒤(둘 다 꺼짐)에는 차단돼야 한다.
    const dAdmin = await getData(api, adminToken);
    const employees3 = dAdmin.data.employees.map(e => e.id === "dir1"
      ? { ...e, menuPerms: { ...e.menuPerms, "comp-grade-view": false } }
      : e);
    await api("/save", auth(adminToken, "POST", { _version: dAdmin.version, employees: employees3 }));
    const dir1Token2 = await login(api, "dir1", "dir1-pw-1");

    d = await getData(api, dir1Token2);
    gradeAdjustHistory = [...(d.data.gradeAdjustHistory || []), { id: "gah2", type: "kpi", empId: "memberA", year: 2026, dept: "개발본부", oldGrade: "-", newGrade: "B" }];
    r = await api("/save", auth(dir1Token2, "POST", { _version: d.version, gradeAdjustHistory }));
    assert.equal(r.status, 200);
    check = await getData(api, adminToken);
    assert.equal((check.data.gradeAdjustHistory || []).some(x => x.id === "gah2"), false);
  });
});
