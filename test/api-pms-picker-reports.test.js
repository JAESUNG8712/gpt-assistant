"use strict";

// "구조적 한계 #2"(회계·ERP 등 대량 조회 API가 menuPerms로 좁혀지지 않던 문제)의 PMS 모듈
// 증분 — 조사 결과 PMS는 GET .../pms/projects·GET .../pms/worklogs가 이미 row-level
// 스코핑(프로젝트 조회권한 판정·member는 자기 employeeId로 강제)이 돼 있고, 두 페이지 이상이
// 정당하게 공유해야 하는 구조(예: worklogs는 "일일 업무 투입"(전 역할 자기 입력)와
// "가동률 현황"(admin/director/leader 팀 전체 조회)가 같은 API를 서로 다른 의도로 호출) —
// 이 둘은 accounting/ERP의 items/locations와 동일한 이유로 게이팅 대상에서 제외했다.
// 유일하게 손댄 것은 GET .../pms/allocations — "가동률 현황"이 2026-07-27에 업무일지
// 합산 방식으로 이미 재구현되면서 클라이언트에서 완전히 죽은 호출이 된 것을 발견해
// 벌크로딩에서 제거하고, 남겨둔 API 표면은 원래 용도였던 페이지 기준으로 게이팅했다.
const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer, bootstrapAdminAndLogin } = require("./support/start-server");

async function login(api, loginId, pw) {
  const response = await api("/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ loginId, pw }),
  });
  const body = await response.json();
  assert.equal(body.ok, true, `${loginId} 로그인 실패`);
  return body.token;
}

function auth(token, method, body) {
  return {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  };
}

test("PMS: GET .../pms/allocations 게이팅 + projects/worklogs는 이미 안전해 미변경", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const api = (path, options) => fetch(server.baseUrl + path, options);

  const boot = await bootstrapAdminAndLogin(server, { loginId: "admin1", pw: "admin1-test-pw", name: "관리자1" });
  const adminToken = boot.token;

  const initial = await (await api("/data", { headers: { Authorization: `Bearer ${adminToken}` } })).json();
  const employees = [
    ...initial.data.employees.map(e => e.loginId === "admin1"
      ? { ...e, menuPerms: { "pms-utilization": false } }
      : e),
    { id: "admin2", loginId: "admin2", pw: "admin2-test-pw", name: "관리자2", role: "admin", active: true, menuPerms: {} },
    { id: "member1", loginId: "member1", pw: "member1-test-pw", name: "일반직원", role: "member", active: true, dept: "영업본부", team: "영업1팀", menuPerms: {} },
    // pms-utilization은 허용, pms-allocation(내 투입률 입력)만 개인적으로 꺼둔 admin —
    // GET .../allocations의 유일한 실제 소비처는 "가동률 현황"(pms-utilization)인데,
    // MODULE_MENU_BY_PATH의 블랭킷 미들웨어가 메서드 구분 없이 pms-allocation까지 함께
    // 요구하면 이 사용자가 GET에서 잘못된 403을 받는다(병행 세션이 각자 추가한 두
    // 게이팅이 서로 몰랐던 충돌, 실측 확인·수정).
    { id: "admin3", loginId: "admin3", pw: "admin3-test-pw", name: "관리자3", role: "admin", active: true, menuPerms: { "pms-allocation": false } },
  ];
  const seed = await api("/save", auth(adminToken, "POST", { _version: initial.version, data: { ...initial.data, employees } }));
  assert.equal(seed.status, 200);

  const restrictedToken = adminToken; // admin1 — pms-utilization 개인적으로 꺼짐
  const admin2Token = await login(api, "admin2", "admin2-test-pw");
  const memberToken = await login(api, "member1", "member1-test-pw");
  const admin3Token = await login(api, "admin3", "admin3-test-pw"); // pms-allocation만 꺼짐

  const proj = await (await api("/api/pms/projects", auth(admin2Token, "POST", {
    name: "테스트프로젝트", members: [1],
  }))).json();
  assert.equal(proj.ok, true);

  const alloc = await (await api("/api/pms/allocations", auth(admin2Token, "POST", {
    employeeId: 1, year: 2031, month: 6, projectId: proj.project.id, percent: 50, memo: "테스트",
  }))).json();
  assert.equal(alloc.ok, true);

  await t.test("GET .../pms/allocations — pms-utilization을 개인적으로 꺼둔 admin1은 403, 대조군 admin2는 200", async () => {
    const r1 = await api("/api/pms/allocations", { headers: { Authorization: `Bearer ${restrictedToken}` } });
    assert.equal(r1.status, 403);
    const r2 = await api("/api/pms/allocations", { headers: { Authorization: `Bearer ${admin2Token}` } });
    assert.equal(r2.status, 200);
    const body = await r2.json();
    assert.equal(body.ok, true);
    assert.ok(body.allocations.some(a => a.projectId === proj.project.id));
  });

  await t.test("GET .../pms/allocations — pms-allocation만 꺼둔 admin3은 여전히 200(pms-utilization 기준), POST는 403(pms-allocation 기준)", async () => {
    const getR = await api("/api/pms/allocations", { headers: { Authorization: `Bearer ${admin3Token}` } });
    assert.equal(getR.status, 200, "블랭킷 미들웨어가 GET에도 pms-allocation을 요구하면 여기서 잘못 403이 난다");
    const postR = await api("/api/pms/allocations", auth(admin3Token, "POST", {
      employeeId: 1, year: 2031, month: 7, projectId: proj.project.id, percent: 10, memo: "차단되어야 함",
    }));
    assert.equal(postR.status, 403, "실제 쓰기(내 투입률 등록)는 여전히 pms-allocation으로 막혀야 함");
  });

  await t.test("GET .../pms/projects — 이번 증분에서 게이팅하지 않음(전 역할 공개+row 스코핑), member도 조회 가능", async () => {
    const r = await api("/api/pms/projects", { headers: { Authorization: `Bearer ${memberToken}` } });
    assert.equal(r.status, 200);
  });

  await t.test("GET .../pms/worklogs — 이번 증분에서 게이팅하지 않음(worklog 자기입력+가동률 팀조회 두 화면이 공유), member도 조회 가능(자기 것만)", async () => {
    const r = await api("/api/pms/worklogs", { headers: { Authorization: `Bearer ${memberToken}` } });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);
  });
});
