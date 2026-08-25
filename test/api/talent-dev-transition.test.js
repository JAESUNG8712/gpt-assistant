"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer, bootstrapAdminAndLogin } = require("../support/start-server");

function auth(token, body) { return { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }; }
async function login(api, loginId, pw) {
  const response = await api("/login", auth(null, { loginId, pw }));
  const body = await response.json(); assert.equal(body.ok, true, `${loginId} 로그인 실패`); return body.token;
}

test("인재육성 계획 상태전이: 서버 역할·조직·revision 검증", async (t) => {
  const server = await startServer(); t.after(() => server.stop());
  const api = (path, options) => fetch(server.baseUrl + path, options);
  const boot = await bootstrapAdminAndLogin(server, { loginId: "admin", pw: "admin-test-pw", name: "관리자" });
  const initial = await (await api("/data", { headers: { Authorization: `Bearer ${boot.token}` } })).json();
  const createdAt = "2026-08-25T00:00:00.000Z";
  const employees = [
    ...initial.data.employees,
    { id: "member-a", loginId: "membera", pw: "member-a-pw", name: "팀원 A", role: "member", active: true, dept: "개발본부", team: "플랫폼팀" },
    { id: "leader-a", loginId: "leadera", pw: "leader-a-pw", name: "팀장 A", role: "leader", active: true, dept: "개발본부", team: "플랫폼팀" },
    { id: "leader-b", loginId: "leaderb", pw: "leader-b-pw", name: "팀장 B", role: "leader", active: true, dept: "개발본부", team: "데이터팀" },
    { id: "director-a", loginId: "directora", pw: "director-a-pw", name: "사업부장 A", role: "director", active: true, dept: "개발본부", team: "" },
    { id: "director-b", loginId: "directorb", pw: "director-b-pw", name: "사업부장 B", role: "director", active: true, dept: "영업본부", team: "" },
  ];
  const plan = { id: "td-1", empId: "member-a", year: 2026, type: "plan", status: "draft", createdAt, updatedAt: createdAt };
  const seed = await api("/save", auth(boot.token, { _version: initial.version, data: { ...initial.data, employees, talentDevPlans: [plan] } }));
  assert.equal(seed.status, 200);

  const member = await login(api, "membera", "member-a-pw");
  const leader = await login(api, "leadera", "leader-a-pw");
  const foreignLeader = await login(api, "leaderb", "leader-b-pw");
  const director = await login(api, "directora", "director-a-pw");
  const foreignDirector = await login(api, "directorb", "director-b-pw");
  const transition = (token, body) => api("/api/talent-dev/plans/td-1/transition", auth(token, body));

  const submittedResponse = await transition(member, { action: "submit", expectedUpdatedAt: createdAt });
  assert.equal(submittedResponse.status, 200); const submitted = (await submittedResponse.json()).plan;
  assert.equal(submitted.status, "submitted");

  const wrongTeam = await transition(foreignLeader, { action: "approve", expectedUpdatedAt: submitted.updatedAt });
  assert.equal(wrongTeam.status, 403); assert.equal((await wrongTeam.json()).code, "TD_SCOPE_FORBIDDEN");

  const approvedResponse = await transition(leader, { action: "approve", expectedUpdatedAt: submitted.updatedAt, comment: "1차 승인" });
  assert.equal(approvedResponse.status, 200); const leaderApproved = (await approvedResponse.json()).plan;
  assert.equal(leaderApproved.status, "leader_approved");

  const stale = await transition(leader, { action: "approve", expectedUpdatedAt: submitted.updatedAt });
  assert.equal(stale.status, 409); assert.equal((await stale.json()).code, "TD_PLAN_CONFLICT");

  const wrongDept = await transition(foreignDirector, { action: "approve", expectedUpdatedAt: leaderApproved.updatedAt, comment: "우회" });
  assert.equal(wrongDept.status, 403);
  const missingComment = await transition(director, { action: "approve", expectedUpdatedAt: leaderApproved.updatedAt });
  assert.equal(missingComment.status, 400);

  const finalResponse = await transition(director, { action: "approve", expectedUpdatedAt: leaderApproved.updatedAt, comment: "최종 승인" });
  assert.equal(finalResponse.status, 200); const finalPlan = (await finalResponse.json()).plan;
  assert.equal(finalPlan.status, "director_approved");

  const invalidRegression = await transition(leader, { action: "approve", expectedUpdatedAt: finalPlan.updatedAt });
  assert.equal(invalidRegression.status, 409); assert.equal((await invalidRegression.json()).code, "TD_INVALID_TRANSITION");
});
