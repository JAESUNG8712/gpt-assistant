"use strict";

// 가감점(상벌점, Epic C — HR마인드 벤치마킹) — 등급조정(gradeAdjustHistory)과 동일한 패턴으로
// 서버에 배선했다(2026-10). calcEmpFinalScore/calcCompGradesForAll이 raw score에 그대로
// 더해 상대평가 순위에 직접 영향을 주는 만큼, 쓰기 권한(admin 전체 + director는 자기
// 사업부만)·menuPerms 개인별 게이팅·값 검증(points 범위·year 범위·type·reason 필수)을
// gradeAdjustHistory와 동일하게, 읽기 필터는 kpiEntries와 동일하게(leader/director는 전체를
// 봐야 자기 팀/부서 점수를 올바르게 계산할 수 있으므로 member만 본인 레코드로 제한) 검증한다.
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
function makeAdj(id, empId, overrides) {
  return {
    id, type: "kpi", empId, year: 2025, dept: "개발본부", points: 5, reason: "우수 기여",
    appliedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

test("가감점(scoreAdjustments) — role/directorDeptField 게이팅·menuPerms·값 검증·읽기범위·protected-merge", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const api = (path, options) => fetch(server.baseUrl + path, options);

  const boot = await bootstrapAdminAndLogin(server, { loginId: "admin1", pw: "admin1-test-pw", name: "관리자1" });
  const adminToken = boot.token;
  const initial = await getData(api, adminToken);

  const employees = [
    ...initial.data.employees,
    { id: "dir1", loginId: "dir1", pw: "dir1-test-pw", name: "사업부장1", role: "director", active: true, dept: "개발본부", menuPerms: {} },
    { id: "dir2", loginId: "dir2", pw: "dir2-test-pw", name: "사업부장2", role: "director", active: true, dept: "영업본부", menuPerms: {} },
    { id: "ldr1", loginId: "ldr1", pw: "ldr1-test-pw", name: "팀장1", role: "leader", active: true, dept: "개발본부", team: "A팀", menuPerms: {} },
    { id: "mem1", loginId: "mem1", pw: "mem1-test-pw", name: "팀원1", role: "member", active: true, dept: "개발본부", team: "A팀", menuPerms: {} },
  ];
  const seed = await api("/save", auth(adminToken, "POST", { _version: initial.version, employees }));
  assert.equal(seed.status, 200);

  const dir1Token = await login(api, "dir1", "dir1-test-pw");
  const dir2Token = await login(api, "dir2", "dir2-test-pw");
  const ldr1Token = await login(api, "ldr1", "ldr1-test-pw");
  const mem1Token = await login(api, "mem1", "mem1-test-pw");

  await t.test("member는 자기 자신에게도 가감점을 만들 수 없다(ownField 없음, 조용히 드롭)", async () => {
    const d = await getData(api, mem1Token);
    const r = await api("/save", auth(mem1Token, "POST", {
      _version: d.version,
      scoreAdjustments: [makeAdj("sa-m1", "mem1")],
    }));
    assert.equal(r.status, 200);
    const check = await getData(api, adminToken);
    assert.equal((check.data.scoreAdjustments || []).length, 0);
  });

  await t.test("leader는 가감점을 만들 수 없다(역할 규칙 밖, 조용히 드롭)", async () => {
    const d = await getData(api, ldr1Token);
    const r = await api("/save", auth(ldr1Token, "POST", {
      _version: d.version,
      scoreAdjustments: [makeAdj("sa-l1", "mem1")],
    }));
    assert.equal(r.status, 200);
    const check = await getData(api, adminToken);
    assert.equal((check.data.scoreAdjustments || []).length, 0);
  });

  await t.test("다른 부서 director는 가감점을 만들 수 없다(directorDeptField, 조용히 드롭)", async () => {
    const d = await getData(api, dir2Token);
    const r = await api("/save", auth(dir2Token, "POST", {
      _version: d.version,
      scoreAdjustments: [makeAdj("sa-d2", "mem1")], // mem1은 개발본부, dir2는 영업본부
    }));
    assert.equal(r.status, 200);
    const check = await getData(api, adminToken);
    assert.equal((check.data.scoreAdjustments || []).length, 0);
  });

  await t.test("같은 부서 director는 가감점을 만들 수 있다", async () => {
    const d = await getData(api, dir1Token);
    const r = await api("/save", auth(dir1Token, "POST", {
      _version: d.version,
      scoreAdjustments: [makeAdj("sa-d1", "mem1")],
    }));
    assert.equal(r.status, 200);
    const check = await getData(api, adminToken);
    const rec = (check.data.scoreAdjustments || []).find(a => a.id === "sa-d1");
    assert.ok(rec, "director가 만든 레코드가 저장돼야 함");
    assert.equal(rec.points, 5);
  });

  await t.test("admin은 임의 직원에 가감점을 만들 수 있다", async () => {
    const d = await getData(api, adminToken);
    const r = await api("/save", auth(adminToken, "POST", {
      _version: d.version,
      scoreAdjustments: [...(d.data.scoreAdjustments || []), makeAdj("sa-admin1", "mem1", { points: -3, reason: "지각 3회", type: "comp" })],
    }));
    assert.equal(r.status, 200);
    const check = await getData(api, adminToken);
    const rec = (check.data.scoreAdjustments || []).find(a => a.id === "sa-admin1");
    assert.ok(rec);
    assert.equal(rec.points, -3);
    assert.equal(rec.type, "comp");
  });

  await t.test("값 검증: points=0/범위초과/type 오류/reason 누락/year 범위초과는 신규 레코드가 드롭된다", async () => {
    const d = await getData(api, adminToken);
    const base = d.data.scoreAdjustments || [];
    const bad = [
      makeAdj("sa-bad-zero", "mem1", { points: 0 }),
      makeAdj("sa-bad-huge", "mem1", { points: 999 }),
      makeAdj("sa-bad-type", "mem1", { type: "leadership" }),
      makeAdj("sa-bad-reason", "mem1", { reason: "" }),
      makeAdj("sa-bad-year", "mem1", { year: 1800 }),
    ];
    const r = await api("/save", auth(adminToken, "POST", { _version: d.version, scoreAdjustments: [...base, ...bad] }));
    assert.equal(r.status, 200);
    const check = await getData(api, adminToken);
    const ids = new Set((check.data.scoreAdjustments || []).map(a => a.id));
    for (const b of bad) assert.equal(ids.has(b.id), false, `${b.id}는 저장되면 안 됨`);
  });

  await t.test("menuPerms: grade-view/comp-grade-view를 모두 꺼둔 admin은 쓸 수 없다(두 화면 다 꺼졌을 때만 차단)", async () => {
    const d = await getData(api, adminToken);
    const employeesWithPermOff = d.data.employees.map(e =>
      e.id === "admin1" || e.loginId === "admin1" ? { ...e, menuPerms: { "grade-view": false, "comp-grade-view": false } } : e
    );
    await api("/save", auth(adminToken, "POST", { _version: d.version, employees: employeesWithPermOff }));
    const d2 = await getData(api, adminToken);
    const r = await api("/save", auth(adminToken, "POST", {
      _version: d2.version,
      scoreAdjustments: [...(d2.data.scoreAdjustments || []), makeAdj("sa-blocked", "mem1")],
    }));
    assert.equal(r.status, 200);
    const check = await getData(api, adminToken);
    assert.equal((check.data.scoreAdjustments || []).some(a => a.id === "sa-blocked"), false);

    // 원복: 메뉴 권한을 다시 켜서 이후 테스트에 영향 없게 한다.
    const d3 = await getData(api, adminToken);
    const restored = d3.data.employees.map(e => (e.id === "admin1" || e.loginId === "admin1") ? { ...e, menuPerms: {} } : e);
    await api("/save", auth(adminToken, "POST", { _version: d3.version, employees: restored }));
  });

  await t.test("읽기 범위: member는 자기 레코드만, director/leader/admin은 전체를 본다", async () => {
    const memData = await getData(api, mem1Token);
    assert.ok((memData.data.scoreAdjustments || []).every(a => a.empId === "mem1"));
    assert.ok((memData.data.scoreAdjustments || []).length > 0, "본인 레코드는 보여야 함");

    const dirData = await getData(api, dir1Token);
    const adminData = await getData(api, adminToken);
    assert.equal((dirData.data.scoreAdjustments || []).length, (adminData.data.scoreAdjustments || []).length,
      "director는 kpiEntries와 동일하게 전체를 봐야 팀 점수를 올바르게 계산할 수 있다");

    const ldrData = await getData(api, ldr1Token);
    assert.equal((ldrData.data.scoreAdjustments || []).length, (adminData.data.scoreAdjustments || []).length,
      "leader도 동일하게 전체를 봐야 한다");
  });

  await t.test("protected-merge: member의 필터링된(불완전한) 로컬 배열을 그대로 재저장해도 타인 레코드가 지워지지 않는다", async () => {
    const before = await getData(api, adminToken);
    const beforeCount = (before.data.scoreAdjustments || []).length;
    assert.ok(beforeCount > 1, "사전조건: admin이 보는 레코드가 2건 이상이어야 의미 있는 검증");

    const memData = await getData(api, mem1Token); // mem1은 자기 레코드만 보이는 불완전한 로컬 상태
    const r = await api("/save", auth(mem1Token, "POST", { _version: memData.version, scoreAdjustments: memData.data.scoreAdjustments }));
    assert.equal(r.status, 200);

    const after = await getData(api, adminToken);
    assert.equal((after.data.scoreAdjustments || []).length, beforeCount, "다른 직원(admin이 만든) 레코드가 지워지면 안 됨");
  });
});
