// Epic B #1/#5/#7(2026-10) — KPI 평가 단계를 2단계(팀장/사업부장) 하드코딩에서
// settings.kpiApprovalStages 기반 N단계(최소 2~최대 5)로 일반화한 _sanitizeKpiEntry()
// 검증. 핵심 설계: stages[0]/stages[마지막]은 기존 필드명(firstStatus/finalStatus 등)을
// 그대로 쓰므로 기본 2단계 구성에서는 동작이 전혀 바뀌지 않는다(그 회귀는
// test/api-blob-menu-perms.test.js·test/api-kpi-feedback-thread.test.js가 이미 커버) —
// 이 파일은 (1) 3단계 이상 구성 시의 중간 단계(middleStages) 순서·권한 강제, (2) 마감
// (kpiApprovalDeadline) 서버 강제, (3) 조정기간(kpiAdjustmentPeriod) 중 재오픈만 새로
// 검증한다.
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

test("KPI N단계 평가(3단계 구성) — 순서 강제·specific_employee 승인자·마감/조정기간", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const api = (path, options) => fetch(server.baseUrl + path, options);

  const boot = await bootstrapAdminAndLogin(server, { loginId: "admin", pw: "admin-test-pw-1", name: "관리자" });
  const adminToken = boot.token;
  const initial = await getData(api, adminToken);

  const employees = [
    ...initial.data.employees,
    { id: "leader1", loginId: "leader1", pw: "leader1-pw-1", name: "팀장", role: "leader", active: true, dept: "개발본부", team: "A팀", menuPerms: {} },
    { id: "hrReview", loginId: "hrReview", pw: "hrReview-pw-1", name: "인사팀검토자", role: "member", active: true, dept: "경영지원본부", menuPerms: {} },
    { id: "otherEmp", loginId: "otherEmp", pw: "otherEmp-pw-1", name: "무관직원", role: "member", active: true, dept: "개발본부", menuPerms: {} },
    { id: "dir1", loginId: "dir1", pw: "dir1-pw-1", name: "사업부장", role: "director", active: true, dept: "개발본부", menuPerms: {} },
    { id: "member1", loginId: "member1", pw: "member1-pw-1", name: "팀원", role: "member", active: true, dept: "개발본부", team: "A팀", menuPerms: {} },
  ];
  // 3단계: 1차(팀장) → 2차(인사팀 특정 검토자, specific_employee) → 최종(사업부장).
  const settings = {
    kpiApprovalStages: [
      { id: "stage1", label: "1차(팀장)", kind: "team_leader" },
      { id: "stageHr", label: "2차(인사팀 검토)", kind: "specific_employee", approverEmpId: "hrReview" },
      { id: "stageFinal", label: "최종(사업부장)", kind: "dept_director" },
    ],
  };
  const kpiEntries = [
    { id: "kpi1", userId: "member1", year: 2026, title: "목표1", weight: 100, firstStatus: "", finalStatus: "" },
  ];
  const seed = await api("/save", auth(adminToken, "POST", { _version: initial.version, employees, kpiEntries, settings }));
  assert.equal(seed.status, 200, `시드 실패: ${JSON.stringify(await seed.json())}`);

  const leaderToken = await login(api, "leader1", "leader1-pw-1");
  const hrToken = await login(api, "hrReview", "hrReview-pw-1");
  const otherToken = await login(api, "otherEmp", "otherEmp-pw-1");
  const dirToken = await login(api, "dir1", "dir1-pw-1");

  async function kpiOf() {
    const d = await getData(api, adminToken);
    return d.data.kpiEntries.find(k => k.id === "kpi1");
  }
  async function saveKpi(token, patch) {
    const d = await getData(api, token);
    const kpiEntries = d.data.kpiEntries.map(k => k.id === "kpi1" ? { ...k, ...patch } : k);
    return api("/save", auth(token, "POST", { _version: d.version, kpiEntries }));
  }

  await t.test("stageHr(인사팀 검토)는 1차(팀장)가 승인되기 전에는 승인할 수 없다(순서 강제, 신규 기능)", async () => {
    const r = await saveKpi(hrToken, { middleStages: { stageHr: { score: null, comment: "", itemFeedback: "", status: "approved", reason: "" } } });
    assert.equal(r.status, 200);
    const kpi = await kpiOf();
    assert.equal((kpi.middleStages || {}).stageHr?.status || "", "", "1차 미승인 상태에서 중간단계 승인은 되돌려져야 한다");
  });

  await t.test("무관한 직원(otherEmp)은 stageHr을 승인할 수 없다(specific_employee가 아님)", async () => {
    await saveKpi(leaderToken, { firstStatus: "approved", firstScore: 90 });
    const r = await saveKpi(otherToken, { middleStages: { stageHr: { score: 80, comment: "", itemFeedback: "", status: "approved", reason: "" } } });
    assert.equal(r.status, 200);
    const kpi = await kpiOf();
    assert.equal((kpi.middleStages || {}).stageHr?.status || "", "");
  });

  await t.test("1차 승인 후에는 지정된 specific_employee(hrReview)가 중간단계를 승인할 수 있다", async () => {
    const kpi = await kpiOf();
    assert.equal(kpi.firstStatus, "approved", "선행 단계: 팀장 1차승인이 먼저 반영돼 있어야 한다");
    const r = await saveKpi(hrToken, { middleStages: { stageHr: { score: 85, comment: "검토완료", itemFeedback: "", status: "approved", reason: "" } } });
    assert.equal(r.status, 200);
    const after = await kpiOf();
    assert.equal(after.middleStages.stageHr.status, "approved");
    assert.equal(after.middleStages.stageHr.score, 85);
  });

  await t.test("사업부장도 중간단계(stageHr)가 승인되기 전에는 최종확정을 할 수 없다(신규 순서 강제)", async () => {
    // stageHr을 다시 미승인으로 되돌릴 수는 없으니(아직 조정기간 미도입), 별도 레코드로 검증.
    const d = await getData(api, adminToken);
    const kpiEntries2 = [...d.data.kpiEntries, { id: "kpi2", userId: "member1", year: 2026, title: "목표2", weight: 100, firstStatus: "approved" }];
    await api("/save", auth(adminToken, "POST", { _version: d.version, kpiEntries: kpiEntries2 }));
    const d2 = await getData(api, dirToken);
    const kpiEntries3 = d2.data.kpiEntries.map(k => k.id === "kpi2" ? { ...k, finalStatus: "approved", finalConfirmed: true, finalScore: 95 } : k);
    const r = await api("/save", auth(dirToken, "POST", { _version: d2.version, kpiEntries: kpiEntries3 }));
    assert.equal(r.status, 200);
    const check = await getData(api, adminToken);
    const kpi2 = check.data.kpiEntries.find(k => k.id === "kpi2");
    assert.equal(kpi2.finalStatus, "", "중간단계 미승인 상태에서 최종확정은 되돌려져야 한다");
  });

  await t.test("중간단계까지 모두 승인되면 사업부장이 정상적으로 최종확정할 수 있다(승인=최종확정 의미론)", async () => {
    const r = await saveKpi(dirToken, { finalStatus: "approved", finalConfirmed: true, finalScore: 95, secondScore: 95 });
    assert.equal(r.status, 200);
    const kpi = await kpiOf();
    assert.equal(kpi.finalStatus, "approved");
    assert.equal(kpi.finalConfirmed, true);
    assert.equal(kpi.finalScore, 95);
  });

  await t.test("마감일이 지나면 non-admin의 새로운 승인/반려는 서버가 거부한다", async () => {
    const dAdmin = await getData(api, adminToken);
    await api("/save", auth(adminToken, "POST", {
      _version: dAdmin.version,
      kpiEntries: [...dAdmin.data.kpiEntries, { id: "kpi3", userId: "member1", year: 2026, title: "목표3", weight: 100 }],
      settings: { ...dAdmin.data.settings, kpiApprovalDeadline: "2020-01-01" },
    }));
    const d = await getData(api, leaderToken);
    const kpiEntries = d.data.kpiEntries.map(k => k.id === "kpi3" ? { ...k, firstStatus: "approved", firstScore: 70 } : k);
    const r = await api("/save", auth(leaderToken, "POST", { _version: d.version, kpiEntries }));
    assert.equal(r.status, 200);
    const check = await getData(api, adminToken);
    const kpi3 = check.data.kpiEntries.find(k => k.id === "kpi3");
    assert.equal(kpi3.firstStatus || "", "", "마감이 지났으므로 1차승인은 서버가 되돌려야 한다");
  });

  await t.test("admin은 마감과 무관하게 여전히 승인 가능하다(기존 admin 우회 관례 유지)", async () => {
    const d = await getData(api, adminToken);
    const kpiEntries = d.data.kpiEntries.map(k => k.id === "kpi3" ? { ...k, firstStatus: "approved", firstScore: 70 } : k);
    const r = await api("/save", auth(adminToken, "POST", { _version: d.version, kpiEntries }));
    assert.equal(r.status, 200);
    const check = await getData(api, adminToken);
    assert.equal(check.data.kpiEntries.find(k => k.id === "kpi3").firstStatus, "approved");
  });

  await t.test("조정기간을 열면 마감이 지나도 non-admin의 승인이 다시 허용된다", async () => {
    const d = await getData(api, adminToken);
    await api("/save", auth(adminToken, "POST", {
      _version: d.version,
      settings: { ...d.data.settings, kpiAdjustmentPeriod: { open: true, start: "2026-01-01", end: "2026-12-31", note: "연말 조정" } },
    }));
    const d3 = await getData(api, adminToken);
    const kpiEntries3 = [...d3.data.kpiEntries, { id: "kpi4", userId: "member1", year: 2026, title: "목표4", weight: 100 }];
    await api("/save", auth(adminToken, "POST", { _version: d3.version, kpiEntries: kpiEntries3 }));
    const d4 = await getData(api, leaderToken);
    const kpiEntries4 = d4.data.kpiEntries.map(k => k.id === "kpi4" ? { ...k, firstStatus: "approved", firstScore: 60 } : k);
    const r = await api("/save", auth(leaderToken, "POST", { _version: d4.version, kpiEntries: kpiEntries4 }));
    assert.equal(r.status, 200);
    const check = await getData(api, adminToken);
    assert.equal(check.data.kpiEntries.find(k => k.id === "kpi4").firstStatus, "approved", "조정기간이 열려있으면 마감이 지나도 승인이 통과해야 한다");
  });

  await t.test("조정기간 중 사업부장(최종확정 권한자)은 이미 확정된 kpi1을 재오픈할 수 있다", async () => {
    const before = await kpiOf();
    assert.equal(before.finalStatus, "approved");
    const d = await getData(api, dirToken);
    const kpiEntries = d.data.kpiEntries.map(k => k.id === "kpi1" ? { ...k, finalStatus: "" } : k);
    const r = await api("/save", auth(dirToken, "POST", { _version: d.version, kpiEntries }));
    assert.equal(r.status, 200);
    const after = await kpiOf();
    assert.equal(after.finalStatus, "", "조정기간 중 재오픈은 허용돼야 한다");
    assert.equal(after.finalConfirmed, false, "재오픈 시 finalConfirmed도 함께 꺼져야 한다");
    assert.equal(after.finalScore, 95, "재오픈해도 과거 점수(finalScore)는 감사를 위해 보존돼야 한다");
    assert.equal(Array.isArray(after.adjustmentHistory), true);
    assert.equal(after.adjustmentHistory.length, 1);
    assert.equal(after.adjustmentHistory[0].stageId, "stageFinal");
    assert.equal(after.adjustmentHistory[0].reopenedBy, "dir1");
  });

  await t.test("조정기간을 닫으면 재오픈 시도는 서버가 거부한다(되돌림)", async () => {
    // 신규 레코드(kpi6)로 1차→중간→최종까지 정식 절차를 전부 밟아 최종확정시킨 뒤,
    // 조정기간을 닫고 재오픈을 시도한다(kpi2는 중간단계가 승인되지 않은 반쪽 상태라
    // 이 테스트의 전제인 "정상적으로 최종확정된 레코드"에 맞지 않아 새로 만든다).
    const dAdmin0 = await getData(api, adminToken);
    await api("/save", auth(adminToken, "POST", {
      _version: dAdmin0.version,
      kpiEntries: [...dAdmin0.data.kpiEntries, { id: "kpi6", userId: "member1", year: 2026, title: "목표6", weight: 100 }],
      settings: { ...dAdmin0.data.settings, kpiAdjustmentPeriod: { open: true } }, // 아직 마감 전이라 조정기간 없이도 승인 가능해야 하지만, 앞 테스트들이 이미 열어둔 상태를 그대로 유지
    }));
    const d1 = await getData(api, leaderToken);
    await api("/save", auth(leaderToken, "POST", {
      _version: d1.version,
      kpiEntries: d1.data.kpiEntries.map(k => k.id === "kpi6" ? { ...k, firstStatus: "approved", firstScore: 80 } : k),
    }));
    const d2 = await getData(api, hrToken);
    await api("/save", auth(hrToken, "POST", {
      _version: d2.version,
      kpiEntries: d2.data.kpiEntries.map(k => k.id === "kpi6" ? { ...k, middleStages: { stageHr: { score: 80, comment: "", itemFeedback: "", status: "approved", reason: "" } } } : k),
    }));
    const d3 = await getData(api, dirToken);
    await api("/save", auth(dirToken, "POST", {
      _version: d3.version,
      kpiEntries: d3.data.kpiEntries.map(k => k.id === "kpi6" ? { ...k, finalStatus: "approved", finalConfirmed: true, finalScore: 88, secondScore: 88 } : k),
    }));
    const afterSetup = (await getData(api, adminToken)).data.kpiEntries.find(k => k.id === "kpi6");
    assert.equal(afterSetup.finalStatus, "approved", "정식 절차를 밟았으므로 최종확정이 정상 반영돼 있어야 한다(사전 조건)");

    const dAdmin = await getData(api, adminToken);
    await api("/save", auth(adminToken, "POST", {
      _version: dAdmin.version,
      settings: { ...dAdmin.data.settings, kpiAdjustmentPeriod: { open: false }, kpiApprovalDeadline: "" },
    }));

    const d = await getData(api, dirToken);
    const before = d.data.kpiEntries.find(k => k.id === "kpi6");
    assert.equal(before.finalStatus, "approved");
    const kpiEntries = d.data.kpiEntries.map(k => k.id === "kpi6" ? { ...k, finalStatus: "" } : k);
    const r = await api("/save", auth(dirToken, "POST", { _version: d.version, kpiEntries }));
    assert.equal(r.status, 200);
    const check = await getData(api, adminToken);
    const kpi6 = check.data.kpiEntries.find(k => k.id === "kpi6");
    assert.equal(kpi6.finalStatus, "approved", "조정기간이 닫혀있으면 재오픈 시도는 거부(되돌림)돼야 한다");
    assert.equal(kpi6.finalConfirmed, true);
  });

  await t.test("임의 문자열(가령 'banana')로의 전이는 서버가 거부한다(기존 느슨한 검증 보강)", async () => {
    const d = await getData(api, adminToken);
    const kpiEntries = [...d.data.kpiEntries, { id: "kpi5", userId: "member1", year: 2026, title: "목표5", weight: 100, firstStatus: "" }];
    await api("/save", auth(adminToken, "POST", { _version: d.version, kpiEntries }));
    const d2 = await getData(api, leaderToken);
    const kpiEntries2 = d2.data.kpiEntries.map(k => k.id === "kpi5" ? { ...k, firstStatus: "banana" } : k);
    const r = await api("/save", auth(leaderToken, "POST", { _version: d2.version, kpiEntries: kpiEntries2 }));
    assert.equal(r.status, 200);
    const check = await getData(api, adminToken);
    assert.equal(check.data.kpiEntries.find(k => k.id === "kpi5").firstStatus, "", "알 수 없는 상태값은 저장본(빈 값)으로 되돌려져야 한다");
  });
});

test("KPI 단계 구성 — 미설정/손상된 설정은 안전하게 기본 2단계로 폴백한다", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const api = (path, options) => fetch(server.baseUrl + path, options);
  const boot = await bootstrapAdminAndLogin(server, { loginId: "admin", pw: "admin-test-pw-1", name: "관리자" });
  const adminToken = boot.token;
  const initial = await getData(api, adminToken);

  const employees = [
    ...initial.data.employees,
    { id: "leader1", loginId: "leader1", pw: "leader1-pw-1", name: "팀장", role: "leader", active: true, dept: "개발본부", team: "A팀", menuPerms: {} },
    { id: "member1", loginId: "member1", pw: "member1-pw-1", name: "팀원", role: "member", active: true, dept: "개발본부", team: "A팀", menuPerms: {} },
  ];
  // 손상된 구성(specific_employee인데 approverEmpId가 없음) — 기본 2단계로 폴백해야 한다.
  const settings = { kpiApprovalStages: [{ id: "a", kind: "specific_employee" }, { id: "b", kind: "dept_director" }] };
  const kpiEntries = [{ id: "kpi1", userId: "member1", year: 2026, title: "목표1", weight: 100 }];
  const seed = await api("/save", auth(adminToken, "POST", { _version: initial.version, employees, kpiEntries, settings }));
  assert.equal(seed.status, 200);

  const leaderToken = await login(api, "leader1", "leader1-pw-1");
  const d = await getData(api, leaderToken);
  const kpiEntries2 = d.data.kpiEntries.map(k => k.id === "kpi1" ? { ...k, firstStatus: "approved", firstScore: 77 } : k);
  const r = await api("/save", auth(leaderToken, "POST", { _version: d.version, kpiEntries: kpiEntries2 }));
  assert.equal(r.status, 200, `팀장 1차승인 실패: ${JSON.stringify(await r.json())}`);
  const check = await getData(api, adminToken);
  assert.equal(check.data.kpiEntries.find(k => k.id === "kpi1").firstStatus, "approved",
    "손상된 kpiApprovalStages는 기본 2단계(team_leader/dept_director)로 폴백해 팀장 승인이 정상 동작해야 한다");
});
