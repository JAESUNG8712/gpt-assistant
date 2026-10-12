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
    const rejected = await r.json();
    assert.equal(rejected.partial, true, "서버가 보호 자료를 되돌릴 때 성공으로 보고하면 안 된다");
    assert.deepEqual(rejected.warnings?.rejectedRecords, [{ field: "coreTalentPool", id: "ct1" }]);
    const check = await getData(api, adminToken);
    assert.equal((check.data.coreTalentPool || []).some(c => c.id === "ct1"), false);
  });

  await t.test("승계계획은 관리자 전용이며 menuPerms·응답 필터를 서버에서 강제한다", async () => {
    const d0 = await getData(api, adminToken);
    const employees2 = [
      ...d0.data.employees,
      { id: "successionAdminLimited", loginId: "successionAdminLimited", pw: "succession-admin-pw-1", name: "승계제한관리자", role: "admin", active: true, menuPerms: { "succession-planning": false } },
    ];
    await api("/save", auth(adminToken, "POST", { _version: d0.version, employees: employees2 }));
    const limitedToken = await login(api, "successionAdminLimited", "succession-admin-pw-1");
    const sample = { id: "sp1", title: "개발본부장 승계", incumbentId: "dir1", criticality: "high", riskOfLoss: "high", impactOfLoss: "high", status: "active", candidates: [{ empId: "leaderA", rank: 1, readiness: "ready_now" }] };

    const limited = await getData(api, limitedToken);
    let r = await api("/save", auth(limitedToken, "POST", { _version: limited.version, successionPlans: [sample] }));
    assert.equal(r.status, 200);
    let check = await getData(api, adminToken);
    assert.equal((check.data.successionPlans || []).some(x => x.id === "sp1"), false, "메뉴가 꺼진 관리자의 직접 쓰기는 차단돼야 한다");

    r = await api("/save", auth(adminToken, "POST", { _version: check.version, successionPlans: [sample] }));
    assert.equal(r.status, 200);
    check = await getData(api, adminToken);
    assert.equal(check.data.successionPlans?.[0]?.candidates?.[0]?.readiness, "ready_now");

    const memberView = await getData(api, memberBToken);
    assert.deepEqual(memberView.data.successionPlans, [], "비관리자 응답에는 이탈위험·후보순위가 노출되면 안 된다");
    r = await api("/save", auth(memberBToken, "POST", { _version: memberView.version, successionPlans: [{ ...sample, title: "위조" }] }));
    assert.equal(r.status, 200);
    check = await getData(api, adminToken);
    assert.equal(check.data.successionPlans?.[0]?.title, "개발본부장 승계", "비관리자 쓰기는 기존 값을 보존해야 한다");
  });

  await t.test("직무·직원 스킬 프로필은 관리자 전용이며 menuPerms·응답 필터를 서버에서 강제한다", async () => {
    const d0 = await getData(api, adminToken);
    const employees2 = [
      ...d0.data.employees,
      { id: "skillsAdminLimited", loginId: "skillsAdminLimited", pw: "skills-admin-pw-1", name: "스킬제한관리자", role: "admin", active: true, menuPerms: { "skills-architecture": false } },
    ];
    await api("/save", auth(adminToken, "POST", { _version: d0.version, employees: employees2 }));
    const limitedToken = await login(api, "skillsAdminLimited", "skills-admin-pw-1");
    const job = { id: "job1", title: "제조 ERP PM", status: "active", skills: [{ name: "제조ERP", level: 4, weight: 2 }] };
    const empSkill = { id: "skill1", empId: "memberB", skills: [{ name: "제조ERP", level: 3, evidence: "구축 참여" }] };

    const limited = await getData(api, limitedToken);
    let r = await api("/save", auth(limitedToken, "POST", { _version: limited.version, jobSkillProfiles: [job], employeeSkillProfiles: [empSkill] }));
    assert.equal(r.status, 200);
    let check = await getData(api, adminToken);
    assert.equal((check.data.jobSkillProfiles || []).length, 0);
    assert.equal((check.data.employeeSkillProfiles || []).length, 0);

    r = await api("/save", auth(adminToken, "POST", { _version: check.version, jobSkillProfiles: [job], employeeSkillProfiles: [empSkill] }));
    assert.equal(r.status, 200);
    check = await getData(api, adminToken);
    assert.equal(check.data.jobSkillProfiles?.[0]?.skills?.[0]?.level, 4);
    assert.equal(check.data.employeeSkillProfiles?.[0]?.skills?.[0]?.level, 3);

    const memberView = await getData(api, memberBToken);
    assert.deepEqual(memberView.data.jobSkillProfiles, []);
    assert.deepEqual(memberView.data.employeeSkillProfiles, []);
    r = await api("/save", auth(memberBToken, "POST", { _version: memberView.version, jobSkillProfiles: [{ ...job, title: "위조" }], employeeSkillProfiles: [{ ...empSkill, skills: [] }] }));
    assert.equal(r.status, 200);
    check = await getData(api, adminToken);
    assert.equal(check.data.jobSkillProfiles?.[0]?.title, "제조 ERP PM");
    assert.equal(check.data.employeeSkillProfiles?.[0]?.skills?.length, 1);
  });

  await t.test("전략적 인력계획은 관리자 전용이고 승인 순서·동결·삭제 방어를 서버가 강제한다", async () => {
    let d = await getData(api, adminToken), current;
    const employees2 = [
      ...d.data.employees,
      { id: "wfAdminLimited", loginId: "wfAdminLimited", pw: "wf-admin-pw-1", name: "인력계획제한관리자", role: "admin", active: true, menuPerms: { "workforce-planning": false } },
    ];
    await api("/save", auth(adminToken, "POST", { _version: d.version, employees: employees2 }));
    const limitedToken = await login(api, "wfAdminLimited", "wf-admin-pw-1");
    const scenario = { id: "wf1", name: "2027 성장안", year: 2027, status: "approved", actions: [{ id: "wfa1", type: "hire", dept: "개발본부", count: 2, annualCost: 60000000, effectiveMonth: 4 }], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };

    let limited = await getData(api, limitedToken);
    await api("/save", auth(limitedToken, "POST", { _version: limited.version, workforceScenarios: [scenario] }));
    let check = await getData(api, adminToken);
    assert.equal((check.data.workforceScenarios || []).length, 0, "메뉴가 꺼진 관리자는 생성할 수 없어야 한다");

    await api("/save", auth(adminToken, "POST", { _version: check.version, workforceScenarios: [scenario] }));
    check = await getData(api, adminToken);
    assert.equal(check.data.workforceScenarios?.[0]?.status, "draft", "신규 시나리오는 승인 상태로 직접 생성할 수 없어야 한다");

    current = check.data.workforceScenarios[0];
    const invalid = { id: "wf-invalid", name: "오염값", year: 2027, status: "draft", actions: [{ id: "bad", type: "hire", dept: "개발본부", count: -3, annualCost: -1, effectiveMonth: 13 }], updatedAt: "2026-01-01T00:00:00.500Z" };
    await api("/save", auth(adminToken, "POST", { _version: check.version, workforceScenarios: [current, invalid] }));
    check = await getData(api, adminToken);
    assert.equal(check.data.workforceScenarios.some(x => x.id === "wf-invalid"), false, "비정상 인원·비용·적용월은 서버에서 거부해야 한다");

    current = check.data.workforceScenarios[0];
    await api("/save", auth(adminToken, "POST", { _version: check.version, workforceScenarios: [{ ...current, name: "검토 전 동시 위조", status: "review", updatedAt: "2026-01-01T00:00:00.700Z" }] }));
    check = await getData(api, adminToken);
    assert.equal(check.data.workforceScenarios[0].status, "draft", "상태 전환 요청에 내용 변경을 끼워 넣을 수 없어야 한다");
    assert.equal(check.data.workforceScenarios[0].name, "2027 성장안");

    current = check.data.workforceScenarios[0];
    await api("/save", auth(adminToken, "POST", { _version: check.version, workforceScenarios: [{ ...current, status: "review", updatedAt: "2026-01-01T00:00:01.000Z" }] }));
    check = await getData(api, adminToken);
    current = check.data.workforceScenarios[0];
    assert.equal(current.status, "review");
    await api("/save", auth(adminToken, "POST", { _version: check.version, workforceScenarios: [{ ...current, status: "approved", updatedAt: "2026-01-01T00:00:02.000Z" }] }));
    check = await getData(api, adminToken);
    current = check.data.workforceScenarios[0];
    assert.equal(current.status, "approved");

    await api("/save", auth(adminToken, "POST", { _version: check.version, workforceScenarios: [{ ...current, name: "승인 후 위조", status: "draft", updatedAt: "2026-01-01T00:00:03.000Z" }] }));
    check = await getData(api, adminToken);
    assert.equal(check.data.workforceScenarios[0].name, "2027 성장안");
    assert.equal(check.data.workforceScenarios[0].status, "approved");

    await api("/save", auth(adminToken, "POST", { _version: check.version, recordTombstones: { ...(check.data.recordTombstones || {}), workforceScenarios: [{ id: "wf1", ts: Date.now(), rev: check.data.workforceScenarios[0]._rev || 0 }] } }));
    check = await getData(api, adminToken);
    assert.equal(check.data.workforceScenarios?.[0]?.status, "approved", "승인 시나리오는 tombstone 직접 요청으로도 삭제할 수 없어야 한다");

    const memberView = await getData(api, memberBToken);
    assert.deepEqual(memberView.data.workforceScenarios, [], "비관리자 응답에는 민감한 인력·인건비 계획이 없어야 한다");
    await api("/save", auth(memberBToken, "POST", { _version: memberView.version, recordTombstones: { workforceScenarios: [{ id: "wf1", ts: Date.now() }] } }));
    check = await getData(api, adminToken);
    assert.equal(check.data.workforceScenarios?.[0]?.id, "wf1", "비관리자는 tombstone으로 관리자 전용 자료를 삭제할 수 없어야 한다");
  });

  await t.test("_WRITE_GATED_FIELDS의 pageIds 배열(gradeAdjustHistory) — 하나라도 켜져 있으면 허용, 전부 꺼지면 차단", async () => {
    // dir1은 menuPerms에 grade-view만 false로 설정됨(comp-grade-view는 미설정) — "any allows"라
    // 이 상태에서는 여전히 허용돼야 한다.
    let d = await getData(api, dir1Token);
    let gradeAdjustHistory = [...(d.data.gradeAdjustHistory || []), { id: "gah1", type: "kpi", empId: "memberA", year: 2026, dept: "개발본부", oldGrade: "-", newGrade: "A" }];
    let r = await api("/save", auth(dir1Token, "POST", { _version: d.version, gradeAdjustHistory }));
    assert.equal(r.status, 200);
    assert.equal((await r.json()).partial, false, "정상 등급 조정은 부분 거부로 오인하면 안 된다");
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
    const rejected = await r.json();
    assert.equal(rejected.partial, true);
    assert.deepEqual(rejected.warnings?.rejectedRecords, [{ field: "gradeAdjustHistory", id: "gah2" }]);
    check = await getData(api, adminToken);
    assert.equal((check.data.gradeAdjustHistory || []).some(x => x.id === "gah2"), false);
  });
});

test("/save 병합 응답도 /data와 동일한 개인별 메뉴 권한 필터를 적용한다", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const api = (path, options) => fetch(server.baseUrl + path, options);
  const boot = await bootstrapAdminAndLogin(server, { loginId: "admin", pw: "admin-test-pw-1" });
  const initial = await getData(api, boot.token);
  const restricted = {
    id: "restricted-admin", loginId: "restricted-admin", pw: "restricted-pw-1",
    name: "제한 관리자", role: "admin", active: true,
    menuPerms: { "learning-center": false }
  };
  const member = {
    id: "ordinary-member", loginId: "ordinary-member", pw: "member-pw-1",
    name: "일반 직원", role: "member", active: true,
  };
  const course = {
    id: "private-course", name: "비공개 교육", category: "직무", provider: "사내",
    startDate: "2026-10-01", endDate: "2026-10-02", hours: 2,
    capacity: 10, cost: 0, status: "active", internalNote: "관리자 전용 메모"
  };
  const seeded = await (await api("/save", auth(boot.token, "POST", {
    _version: initial.version,
    employees: [...initial.data.employees, restricted, member],
    learningCourses: [course, { ...course, id: "retired-sensitive-course" }]
  }))).json();
  assert.equal(seeded.ok, true);
  const adminLatest = await getData(api, boot.token);
  const retired = await (await api("/save", auth(boot.token, "POST", {
    _version: adminLatest.version,
    data: { recordTombstones: { learningCourses: [{ id: "retired-sensitive-course", ts: Date.now() }] } }
  }))).json();
  assert.equal(retired.ok, true);
  assert.equal((await getData(api, boot.token)).data.recordTombstones.learningCourses.some(t => t.id === "retired-sensitive-course"), true);
  const restrictedToken = await login(api, restricted.loginId, restricted.pw);
  const visible = await getData(api, restrictedToken);
  assert.deepEqual(visible.data.learningCourses, []);
  assert.equal((visible.data.recordTombstones?.learningCourses || []).length, 0);
  const memberToken = await login(api, member.loginId, member.pw);
  const memberVisible = await getData(api, memberToken);
  assert.deepEqual(memberVisible.data.recordTombstones, {});

  // 의도적으로 오래된 버전을 보내 병합 응답을 강제로 받는다.
  const saved = await (await api("/save", auth(restrictedToken, "POST", {
    _version: 0, data: { learningCourses: [] }
  }))).json();
  assert.equal(saved.ok, true);
  assert.equal(saved.merged, true);
  assert.deepEqual(saved.mergedData.learningCourses, []);
  assert.equal((saved.mergedData.recordTombstones?.learningCourses || []).length, 0);
  assert.equal((await getData(api, boot.token)).data.learningCourses.some(row => row.id === course.id), true);

  const latest = await getData(api, restrictedToken);
  const rejectedDelete = await (await api("/save", auth(restrictedToken, "POST", {
    _version: latest.version,
    data: { recordTombstones: { learningCourses: [{ id: course.id, ts: Date.now() }] } }
  }))).json();
  assert.equal(rejectedDelete.ok, true);
  assert.equal(rejectedDelete.partial, true);
  assert.deepEqual(rejectedDelete.warnings?.rejectedRecords, [
    { field: "learningCourses", id: course.id, operation: "delete" }
  ]);
  const afterDelete = await getData(api, boot.token);
  assert.equal(afterDelete.data.learningCourses.some(row => row.id === course.id), true);
  assert.equal((afterDelete.data.recordTombstones?.learningCourses || []).some(t => t.id === course.id), false);
});

test("KPI 삭제 표식은 소유·조직·메뉴 권한을 따라야 한다", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const api = (path, options) => fetch(server.baseUrl + path, options);
  const boot = await bootstrapAdminAndLogin(server, { loginId: "admin", pw: "admin-test-pw-1" });
  const initial = await getData(api, boot.token);
  const employees = [
    ...initial.data.employees,
    { id: "owner", loginId: "owner", pw: "owner-pw-1", name: "목표 소유자", role: "member", active: true, dept: "A", team: "1" },
    { id: "other", loginId: "other", pw: "other-pw-1", name: "다른 직원", role: "member", active: true, dept: "B", team: "2" },
    { id: "blocked", loginId: "blocked", pw: "blocked-pw-1", name: "메뉴 제한 직원", role: "member", active: true, dept: "A", team: "1", menuPerms: { kpi: false } },
    { id: "leader", loginId: "leader", pw: "leader-pw-1", name: "같은 팀장", role: "leader", active: true, dept: "A", team: "1" },
  ];
  const kpiEntries = [
    { id: "owner-kpi", userId: "owner", year: 2026, item: "소유자 목표", weight: 50 },
    { id: "other-kpi", userId: "other", year: 2026, item: "타인 목표", weight: 50 },
    { id: "blocked-kpi", userId: "blocked", year: 2026, item: "제한 목표", weight: 50 },
    { id: "team-kpi", userId: "owner", year: 2026, item: "팀장 수정 가능 목표", weight: 50 },
    { id: "submitted-kpi", userId: "owner", year: 2026, item: "이미 제출한 목표", weight: 50, goalSub: 1 },
  ];
  const seeded = await (await api("/save", auth(boot.token, "POST", {
    _version: initial.version, employees, kpiEntries,
  }))).json();
  assert.equal(seeded.ok, true);
  const ownerToken = await login(api, "owner", "owner-pw-1");
  const blockedToken = await login(api, "blocked", "blocked-pw-1");
  const leaderToken = await login(api, "leader", "leader-pw-1");

  async function deleteWith(token, id) {
    const d = await getData(api, token);
    return (await api("/save", auth(token, "POST", {
      _version: d.version,
      data: { recordTombstones: { kpiEntries: [{ id, ts: Date.now() }] } },
    }))).json();
  }

  const foreign = await deleteWith(ownerToken, "other-kpi");
  assert.equal(foreign.partial, true);
  assert.deepEqual(foreign.warnings?.rejectedRecords, [
    { field: "kpiEntries", id: "other-kpi", operation: "delete" },
  ]);
  let after = await getData(api, boot.token);
  assert.equal(after.data.kpiEntries.some(k => k.id === "other-kpi"), true);
  assert.equal((after.data.recordTombstones?.kpiEntries || []).some(t => t.id === "other-kpi"), false);

  const blocked = await deleteWith(blockedToken, "blocked-kpi");
  assert.equal(blocked.partial, true);
  after = await getData(api, boot.token);
  assert.equal(after.data.kpiEntries.some(k => k.id === "blocked-kpi"), true);

  const submitted = await deleteWith(ownerToken, "submitted-kpi");
  assert.equal(submitted.partial, true);
  after = await getData(api, boot.token);
  assert.equal(after.data.kpiEntries.some(k => k.id === "submitted-kpi"), true);

  const team = await deleteWith(leaderToken, "team-kpi");
  assert.equal(team.ok, true);
  assert.equal(team.partial, false);
  after = await getData(api, boot.token);
  assert.equal(after.data.kpiEntries.some(k => k.id === "team-kpi"), false);

  const own = await deleteWith(ownerToken, "owner-kpi");
  assert.equal(own.ok, true);
  assert.equal(own.partial, false);
  after = await getData(api, boot.token);
  assert.equal(after.data.kpiEntries.some(k => k.id === "owner-kpi"), false);
});

test("민감 컬렉션 삭제 표식은 결재·금전 기록과 다른 직원 신청을 지켜야 한다", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const api = (path, options) => fetch(server.baseUrl + path, options);
  const boot = await bootstrapAdminAndLogin(server, { loginId: "admin", pw: "admin-test-pw-1" });
  const initial = await getData(api, boot.token);
  const employees = [
    ...initial.data.employees,
    { id: "claim-owner", loginId: "claim-owner", pw: "claim-owner-pw-1", name: "청구자", role: "member", active: true },
    { id: "claim-other", loginId: "claim-other", pw: "claim-other-pw-1", name: "타 직원", role: "member", active: true },
  ];
  const seeded = await (await api("/save", auth(boot.token, "POST", {
    _version: initial.version, data: {
      employees,
      expenseClaims: [
        { id: "expense-pending", empId: "claim-owner", status: "pending", title: "출장비", total: 10000 },
        { id: "expense-paid", empId: "claim-owner", status: "paid", title: "지급 완료", total: 20000 },
      ],
      overtimeRequests: [
        { id: "overtime-pending", empId: "claim-owner", status: "pending", hours: 2 },
        { id: "overtime-approved", empId: "claim-owner", status: "approved", hours: 3 },
      ],
      welfarePoints: [{ id: "welfare-grant", empId: "claim-owner", type: "grant", points: 10000, year: 2026 }],
      approvalDocs: [{ id: "approval-doc", authorId: "claim-owner", status: "approved", approvers: [] }],
      certRequests: [{ id: "cert-pending", empId: "claim-owner", status: "pending", certType: "employment", reason: "은행 제출" }],
    },
  }))).json();
  assert.equal(seeded.ok, true);
  const ownerToken = await login(api, "claim-owner", "claim-owner-pw-1");
  const otherToken = await login(api, "claim-other", "claim-other-pw-1");

  async function saveWelfare(token, record) {
    const d = await getData(api, token);
    return (await api("/save", auth(token, "POST", {
      _version: d.version, data: { welfarePoints: [record] },
    }))).json();
  }
  await saveWelfare(ownerToken, { id: "welfare-use", empId: "claim-owner", type: "use", points: 2000, year: 2026 });
  let welfare = (await getData(api, boot.token)).data.welfarePoints;
  assert.equal(welfare.find(r => r.id === "welfare-use")?.points, 2000);
  await saveWelfare(ownerToken, { ...welfare.find(r => r.id === "welfare-use"), points: 1 });
  welfare = (await getData(api, boot.token)).data.welfarePoints;
  assert.equal(welfare.find(r => r.id === "welfare-use")?.points, 2000, "사용 금액은 사후 변경할 수 없어야 합니다");
  await saveWelfare(ownerToken, { ...welfare.find(r => r.id === "welfare-grant"), type: "use", points: 1 });
  welfare = (await getData(api, boot.token)).data.welfarePoints;
  assert.equal(welfare.find(r => r.id === "welfare-grant")?.type, "grant", "부여 기록을 사용 기록으로 바꿀 수 없어야 합니다");

  // 삭제뿐 아니라 동일 ID를 이용한 타인 신청 덮어쓰기와 승인 후 금액 변경도
  // 같은 범용 저장 API에서 처리되므로 각각 서버 원본이 유지되어야 한다.
  for (const [token, field, id, patch, checkedKey, original] of [
    [otherToken, "expenseClaims", "expense-pending", { total: 999999 }, "total", 10000],
    [otherToken, "overtimeRequests", "overtime-pending", { hours: 20 }, "hours", 2],
    [ownerToken, "expenseClaims", "expense-paid", { total: 999999 }, "total", 20000],
    [ownerToken, "overtimeRequests", "overtime-approved", { hours: 20 }, "hours", 3],
  ]) {
    const snapshot = await getData(api, boot.token);
    const stored = snapshot.data[field].find(r => r.id === id);
    const changed = { ...stored, ...patch, updatedAt: new Date().toISOString() };
    const result = await (await api("/save", auth(token, "POST", {
      _version: snapshot.version, data: { [field]: [changed] },
    }))).json();
    assert.equal(result.ok, true);
    assert.equal((await getData(api, boot.token)).data[field].find(r => r.id === id)[checkedKey], original,
      `${field}/${id} 승인 근거 변경이 되돌려져야 합니다`);
  }

  async function removeWith(token, field, id) {
    const d = await getData(api, token);
    return (await api("/save", auth(token, "POST", {
      _version: d.version, data: { recordTombstones: { [field]: [{ id, ts: Date.now() }] } },
    }))).json();
  }
  for (const [token, field, id] of [
    [otherToken, "expenseClaims", "expense-pending"],
    [otherToken, "overtimeRequests", "overtime-pending"],
    [ownerToken, "expenseClaims", "expense-paid"],
    [ownerToken, "overtimeRequests", "overtime-approved"],
    [ownerToken, "welfarePoints", "welfare-grant"],
    [ownerToken, "approvalDocs", "approval-doc"],
    [ownerToken, "certRequests", "cert-pending"],
  ]) {
    const result = await removeWith(token, field, id);
    assert.equal(result.partial, true, `${field}/${id} 삭제가 거부되어야 합니다`);
    assert.ok(result.warnings?.rejectedRecords?.some(r => r.field === field && r.id === id && r.operation === "delete"));
    const after = await getData(api, boot.token);
    assert.ok(after.data[field].some(r => r.id === id), `${field}/${id} 원본이 보존되어야 합니다`);
    assert.equal((after.data.recordTombstones?.[field] || []).some(r => r.id === id), false);
  }
  for (const [field, id] of [["expenseClaims", "expense-pending"], ["overtimeRequests", "overtime-pending"]]) {
    const result = await removeWith(ownerToken, field, id);
    assert.equal(result.ok, true);
    assert.equal(result.partial, false);
    assert.equal((await getData(api, boot.token)).data[field].some(r => r.id === id), false);
  }

  async function writeRecord(token, field, record) {
    const d = await getData(api, token);
    return (await api("/save", auth(token, "POST", {
      _version: d.version, data: { [field]: [record] },
    }))).json();
  }
  await writeRecord(ownerToken, "expenseClaims", { id: "expense-forged-owner", empId: "claim-other", status: "pending", total: 50000 });
  await writeRecord(ownerToken, "overtimeRequests", { id: "overtime-forged-status", empId: "claim-owner", status: "approved", hours: 5 });
  await writeRecord(ownerToken, "certRequests", { id: "cert-forged-owner", empId: "claim-other", status: "pending", certType: "salary" });
  await writeRecord(ownerToken, "certRequests", { id: "cert-forged-approved", empId: "claim-owner", status: "approved", certType: "salary" });
  let current = await getData(api, boot.token);
  assert.equal(current.data.expenseClaims.some(r => r.id === "expense-forged-owner"), false);
  assert.equal(current.data.overtimeRequests.some(r => r.id === "overtime-forged-status"), false);
  assert.equal(current.data.certRequests.some(r => r.id === "cert-forged-owner"), false);
  assert.equal(current.data.certRequests.some(r => r.id === "cert-forged-approved"), false);

  await writeRecord(ownerToken, "certRequests", { ...current.data.certRequests.find(r => r.id === "cert-pending"), status: "approved", certType: "salary" });
  current = await getData(api, boot.token);
  assert.equal(current.data.certRequests.find(r => r.id === "cert-pending")?.status, "pending");
  assert.equal(current.data.certRequests.find(r => r.id === "cert-pending")?.certType, "employment");
  await writeRecord(boot.token, "certRequests", { ...current.data.certRequests.find(r => r.id === "cert-pending"), status: "approved", processedAt: "2026-01-01T00:00:00.000Z" });
  current = await getData(api, boot.token);
  assert.equal(current.data.certRequests.find(r => r.id === "cert-pending")?.status, "approved");
  assert.equal(current.data.certRequests.find(r => r.id === "cert-pending")?.certType, "employment");

  await writeRecord(ownerToken, "expenseClaims", { id: "expense-new", empId: "claim-owner", status: "pending", title: "신규 청구", total: 10000 });
  await writeRecord(ownerToken, "overtimeRequests", { id: "overtime-new", empId: "claim-owner", status: "pending", hours: 2 });
  current = await getData(api, boot.token);
  assert.equal(current.data.expenseClaims.find(r => r.id === "expense-new")?.status, "pending");
  assert.equal(current.data.overtimeRequests.find(r => r.id === "overtime-new")?.status, "pending");

  await writeRecord(boot.token, "expenseClaims", { ...current.data.expenseClaims.find(r => r.id === "expense-new"), status: "approved", total: 999999 });
  await writeRecord(boot.token, "overtimeRequests", { ...current.data.overtimeRequests.find(r => r.id === "overtime-new"), status: "approved", hours: 20 });
  current = await getData(api, boot.token);
  assert.equal(current.data.expenseClaims.find(r => r.id === "expense-new")?.status, "approved");
  assert.equal(current.data.expenseClaims.find(r => r.id === "expense-new")?.total, 10000);
  assert.equal(current.data.overtimeRequests.find(r => r.id === "overtime-new")?.status, "approved");
  assert.equal(current.data.overtimeRequests.find(r => r.id === "overtime-new")?.hours, 2);

  await writeRecord(boot.token, "expenseClaims", { ...current.data.expenseClaims.find(r => r.id === "expense-new"), status: "paid", paidAt: "2026-01-01", payMethod: "계좌이체" });
  current = await getData(api, boot.token);
  assert.equal(current.data.expenseClaims.find(r => r.id === "expense-new")?.status, "paid");
  assert.equal(current.data.expenseClaims.find(r => r.id === "expense-new")?.total, 10000);
});

test("전자결재 신규 문서는 작성자·초기 상태를 위조할 수 없고 기존 승인 근거는 불변이다", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const api = (path, options) => fetch(server.baseUrl + path, options);
  const boot = await bootstrapAdminAndLogin(server, { loginId: "admin", pw: "admin-test-pw-1" });
  const first = await getData(api, boot.token);
  const employees = [
    ...first.data.employees,
    { id: "doc-author", loginId: "doc-author", pw: "doc-author-pw-1", name: "기안자", role: "member", active: true },
    { id: "doc-approver", loginId: "doc-approver", pw: "doc-approver-pw-1", name: "결재자", role: "director", active: true },
  ];
  assert.equal((await api("/save", auth(boot.token, "POST", { _version: first.version, data: { employees } }))).status, 200);
  const author = await login(api, "doc-author", "doc-author-pw-1");
  const approver = await login(api, "doc-approver", "doc-approver-pw-1");
  async function saveDoc(token, doc) {
    const d = await getData(api, token);
    return (await api("/save", auth(token, "POST", { _version: d.version, data: { approvalDocs: [doc] } }))).json();
  }
  const base = { templateId: "tpl-expense", authorId: "doc-author", status: "in_progress",
    formData: { amount: 10000 }, approvers: [{ empId: "doc-approver", status: "pending" }],
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
  await saveDoc(author, { ...base, id: "forged-author", authorId: "doc-approver" });
  await saveDoc(author, { ...base, id: "forged-approved", status: "approved", approvers: [{ empId: "doc-approver", status: "approved" }] });
  let adminView = await getData(api, boot.token);
  assert.equal(adminView.data.approvalDocs.some(d => d.id === "forged-author"), false);
  assert.equal(adminView.data.approvalDocs.some(d => d.id === "forged-approved"), false);

  await saveDoc(author, { ...base, id: "real-doc" });
  adminView = await getData(api, boot.token);
  assert.equal(adminView.data.approvalDocs.find(d => d.id === "real-doc")?.status, "in_progress");
  await saveDoc(author, { ...adminView.data.approvalDocs.find(d => d.id === "real-doc"), formData: { amount: 999999 }, updatedAt: "2026-01-02T00:00:00.000Z" });
  adminView = await getData(api, boot.token);
  assert.equal(adminView.data.approvalDocs.find(d => d.id === "real-doc")?.formData?.amount, 10000);

  const approved = { ...adminView.data.approvalDocs.find(d => d.id === "real-doc"), status: "approved", approvedAt: "2026-01-03T00:00:00.000Z",
    approvers: [{ empId: "doc-approver", status: "approved", decidedAt: "2026-01-03T00:00:00.000Z" }], updatedAt: "2026-01-03T00:00:00.000Z" };
  await saveDoc(approver, approved);
  adminView = await getData(api, boot.token);
  assert.equal(adminView.data.approvalDocs.find(d => d.id === "real-doc")?.status, "approved");
  assert.equal(adminView.data.approvalDocs.find(d => d.id === "real-doc")?.formData?.amount, 10000);

  await saveDoc(author, { ...adminView.data.approvalDocs.find(d => d.id === "real-doc"),
    deletionRequest: { status: "pending", reason: "중복 상신", requestedAt: "2026-01-04T00:00:00.000Z" } });
  adminView = await getData(api, boot.token);
  assert.equal(adminView.data.approvalDocs.find(d => d.id === "real-doc")?.deletionRequest?.status, "pending");
  await saveDoc(author, { ...adminView.data.approvalDocs.find(d => d.id === "real-doc"), status: "cancelled" });
  assert.equal((await getData(api, boot.token)).data.approvalDocs.find(d => d.id === "real-doc")?.status, "approved",
    "승인 문서의 삭제 요청은 관리자가 결정하기 전에는 상태를 바꿀 수 없어야 합니다");

  await saveDoc(author, { ...base, id: "cancel-doc" });
  adminView = await getData(api, boot.token);
  const cancelDoc = adminView.data.approvalDocs.find(d => d.id === "cancel-doc");
  await saveDoc(approver, { ...cancelDoc, status: "cancelled", updatedAt: "2026-01-02T00:00:00.000Z" });
  assert.equal((await getData(api, boot.token)).data.approvalDocs.find(d => d.id === "cancel-doc")?.status, "in_progress");
  await saveDoc(author, { ...cancelDoc, status: "cancelled", updatedAt: "2026-01-02T00:00:00.000Z" });
  assert.equal((await getData(api, boot.token)).data.approvalDocs.find(d => d.id === "cancel-doc")?.status, "cancelled");
});
