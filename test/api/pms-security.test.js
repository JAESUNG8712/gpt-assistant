"use strict";

// PMS 권한/동시편집 회귀. 각 테스트는 임시 JSON 파일 + 랜덤 포트의 child process만
// 사용하므로 실제 데이터나 외부 DB를 건드리지 않는다.
const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer, bootstrapAdminAndLogin } = require("../support/start-server");

async function login(api, loginId, pw) {
  const response = await api("/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ loginId, pw }),
  });
  const body = await response.json();
  assert.equal(body.ok, true, `${loginId} 로그인 실패`);
  return body.token;
}

function auth(token, body) {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  };
}

test("PMS: 서버 권한 경계, PM 자동 포함, 동시편집 충돌 방어", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const api = (path, options) => fetch(server.baseUrl + path, options);

  const boot = await bootstrapAdminAndLogin(server, { loginId: "admin", pw: "admin-test-pw", name: "관리자" });
  const adminToken = boot.token;
  const initial = await (await api("/data", { headers: { Authorization: `Bearer ${adminToken}` } })).json();
  const employees = [
    ...initial.data.employees,
    { id: "leader-a", loginId: "leadera", pw: "leader-a-pw", name: "팀장 A", role: "leader", active: true, dept: "개발본부", team: "플랫폼팀" },
    { id: "leader-b", loginId: "leaderb", pw: "leader-b-pw", name: "팀장 B", role: "leader", active: true, dept: "개발본부", team: "데이터팀" },
    { id: "member-a", loginId: "membera", pw: "member-a-pw", name: "팀원 A", role: "member", active: true, dept: "개발본부", team: "플랫폼팀" },
    { id: "member-b", loginId: "memberb", pw: "member-b-pw", name: "팀원 B", role: "member", active: true, dept: "개발본부", team: "데이터팀" },
  ];
  const seed = await api("/save", auth(adminToken, { _version: initial.version, data: { ...initial.data, employees } }));
  assert.equal(seed.status, 200);

  const leaderAToken = await login(api, "leadera", "leader-a-pw");
  const leaderBToken = await login(api, "leaderb", "leader-b-pw");
  const memberAToken = await login(api, "membera", "member-a-pw");
  const memberBToken = await login(api, "memberb", "member-b-pw");

  async function create(token, name, pmId, members) {
    const response = await api("/api/pms/projects", auth(token, { name, pmId, members, memo: `${name} 내부 메모` }));
    assert.equal(response.status, 200, `${name} 생성 실패`);
    return (await response.json()).project;
  }

  const projectA = await create(leaderAToken, "플랫폼 프로젝트", "leader-a", ["member-a"]);
  const projectB = await create(leaderBToken, "데이터 프로젝트", "leader-b", ["member-b"]);

  await t.test("생성자는 body의 user/userId가 아니라 토큰 기준으로 기록되고 PM은 자동 투입된다", async () => {
    assert.equal(projectA.createdById, "leader-a");
    assert.ok(projectA.members.includes("leader-a"), "PM은 투입 인원에 반드시 포함되어야 한다");
    assert.ok(projectA.members.includes("member-a"));
  });

  await t.test("member와 team leader는 자기 범위의 프로젝트만 조회한다", async () => {
    const memberA = await (await api("/api/pms/projects", { headers: { Authorization: `Bearer ${memberAToken}` } })).json();
    assert.deepEqual(memberA.projects.map(p => p.id), [projectA.id]);

    const memberB = await (await api("/api/pms/projects", { headers: { Authorization: `Bearer ${memberBToken}` } })).json();
    assert.deepEqual(memberB.projects.map(p => p.id), [projectB.id]);

    const leaderA = await (await api("/api/pms/projects", { headers: { Authorization: `Bearer ${leaderAToken}` } })).json();
    assert.deepEqual(leaderA.projects.map(p => p.id), [projectA.id]);
    assert.equal(leaderA.projects[0].canManage, true);
  });

  await t.test("다른 팀 leader는 프로젝트 수정·종료를 할 수 없다", async () => {
    const change = await api(`/api/pms/projects/${projectB.id}`, auth(leaderAToken, { name: "탈취 시도", expectedUpdatedAt: projectB.updatedAt }));
    assert.equal(change.status, 403);
    const close = await api(`/api/pms/projects/${projectB.id}/close`, auth(leaderAToken, { expectedUpdatedAt: projectB.updatedAt }));
    assert.equal(close.status, 403);
  });

  await t.test("같은 프로젝트를 오래된 화면에서 저장하면 409 충돌을 반환한다", async () => {
    const first = await api(`/api/pms/projects/${projectA.id}`, auth(leaderAToken, {
      memo: "먼저 저장한 변경", expectedUpdatedAt: projectA.updatedAt,
    }));
    assert.equal(first.status, 200);
    const updated = (await first.json()).project;

    const stale = await api(`/api/pms/projects/${projectA.id}`, auth(leaderAToken, {
      memo: "오래된 탭의 변경", expectedUpdatedAt: projectA.updatedAt,
    }));
    assert.equal(stale.status, 409);
    const staleBody = await stale.json();
    assert.equal(staleBody.code, "PMS_PROJECT_CONFLICT");
    assert.equal(staleBody.project.updatedAt, updated.updatedAt);
  });
});
