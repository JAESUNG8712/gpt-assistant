"use strict";

// 사업계획 승인 워크플로(budget.js)의 서버 규칙 회귀 테스트:
// 팀원 작성(draft) → 해당 사업부장 승인(잠금) → 예산담당자+기획팀장 모두 승인해야 최종확정,
// 잠긴 뒤 수정은 수정요청 → 관리자 승인(재오픈, 승인 이력 초기화)으로만 가능.
// mkdtemp의 DATA_FILE, 랜덤 PORT, child process `node server.js`만 사용한다.
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

test("사업계획 승인 워크플로 권한·상태 전이", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const api = (path, options) => fetch(server.baseUrl + path, options);
  const B = "/api/budget/business-plan";

  const boot = await bootstrapAdminAndLogin(server, { loginId: "admin", pw: "admin-test-pw-1", name: "관리자" });
  const admin = boot.token;
  const initial = await (await api("/data", { headers: { Authorization: `Bearer ${admin}` } })).json();
  const mk = (id, role, dept, team) => ({ id, loginId: id, pw: `${id}-pw-1234`, name: id, role, active: true, dept, team });
  const employees = [
    ...initial.data.employees,
    mk("memA", "member", "영업본부", "영업1팀"),
    mk("memB", "member", "개발본부", "개발1팀"),
    mk("dirA", "director", "영업본부", ""),
    mk("dirB", "director", "개발본부", ""),
    mk("owner", "member", "경영지원본부", "기획팀"),
    mk("lead", "member", "경영지원본부", "기획팀"),
  ];
  const seed = await api("/save", auth(admin, "POST", { _version: initial.version, employees }));
  assert.equal(seed.status, 200);
  const tok = {};
  for (const id of ["memA", "memB", "dirA", "dirB", "owner", "lead"]) {
    const r = await (await api("/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ loginId: id, pw: `${id}-pw-1234` }) })).json();
    assert.equal(r.ok, true, id);
    tok[id] = r.token;
  }
  assert.equal((await api(B + "/settings/roster", auth(admin, "POST", { ownerIds: ["owner"], teamLeaderId: "lead" }))).status, 200);
  assert.equal((await api(B + "/settings/input-window", auth(admin, "POST", { inputOpen: true }))).status, 200);

  const newPlan = async (token, name) => {
    const r = await api(B, auth(token, "POST", { name, baseYear: 2027, years: 1, planType: "costOnly" }));
    assert.equal(r.status, 200, name);
    return (await r.json()).plan;
  };
  const act = async (token, id, action, body) => {
    const r = await api(`${B}/${id}/${action}`, auth(token, "POST", body || {}));
    return { status: r.status, body: await r.json() };
  };

  const plan = await newPlan(tok.memA, "영업1팀 2027");
  await t.test("팀원이 만든 계획은 draft이며 본인 소속(dept/team)으로 귀속된다", async () => {
    assert.equal(plan.status, "draft");
    assert.equal(plan.dept, "영업본부");
    assert.equal(plan.team, "영업1팀");
  });

  await t.test("사업부장 승인: 팀원·다른 부서 사업부장은 403, 해당 사업부장은 잠금", async () => {
    assert.equal((await act(tok.memA, plan.id, "approve-division")).status, 403);
    assert.equal((await act(tok.dirB, plan.id, "approve-division")).status, 403);
    const ok = await act(tok.dirA, plan.id, "approve-division");
    assert.equal(ok.status, 200);
    assert.equal(ok.body.plan.status, "divisionApproved");
    assert.equal((await act(tok.dirA, plan.id, "approve-division")).status, 400, "이미 승인된 계획의 재승인은 거부");
  });

  await t.test("잠긴 계획은 팀원이 직접 수정·삭제할 수 없다", async () => {
    const put = await api(`${B}/${plan.id}`, auth(tok.memA, "PUT", { name: "몰래 수정", baseYear: 2027, years: 1, planType: "costOnly" }));
    assert.equal(put.status, 403);
    const del = await api(`${B}/${plan.id}`, auth(tok.memA, "DELETE"));
    assert.equal(del.status, 403);
  });

  await t.test("최종승인은 예산담당자와 기획팀장 둘 다 승인해야 확정된다", async () => {
    assert.equal((await act(tok.memA, plan.id, "final-approve")).status, 403, "권한 없는 팀원");
    const one = await act(tok.owner, plan.id, "final-approve");
    assert.equal(one.status, 200);
    assert.equal(one.body.plan.status, "divisionApproved", "한 명만 승인하면 아직 확정 아님");
    const two = await act(tok.lead, plan.id, "final-approve");
    assert.equal(two.status, 200);
    assert.equal(two.body.plan.status, "finalConfirmed");
  });

  await t.test("사업부장 승인 전 계획은 최종승인할 수 없다", async () => {
    const p2 = await newPlan(tok.memB, "개발1팀 2027");
    const r = await act(admin, p2.id, "final-approve");
    assert.equal(r.status, 400);
  });

  await t.test("관리자 최종승인은 두 승인을 한 번에 채워 즉시 확정한다", async () => {
    const p3 = await newPlan(tok.memB, "개발1팀 즉시확정");
    assert.equal((await act(tok.dirB, p3.id, "approve-division")).status, 200);
    const r = await act(admin, p3.id, "final-approve");
    assert.equal(r.status, 200);
    assert.equal(r.body.plan.status, "finalConfirmed");
  });

  await t.test("수정요청: 사유 필수, 비관리자는 승인/반려 불가, 관리자 승인 시 draft로 재오픈되고 승인 이력 초기화", async () => {
    assert.equal((await act(tok.memA, plan.id, "request-edit", { reason: "  " })).status, 400);
    assert.equal((await act(tok.memB, plan.id, "request-edit", { reason: "남의 계획" })).status, 403);
    assert.equal((await act(tok.memA, plan.id, "request-edit", { reason: "금액 조정 필요" })).status, 200);
    assert.equal((await act(tok.dirA, plan.id, "edit-request/approve")).status, 403);
    assert.equal((await act(tok.dirA, plan.id, "edit-request/reject")).status, 403);
    const ok = await act(admin, plan.id, "edit-request/approve");
    assert.equal(ok.status, 200);
    assert.equal(ok.body.plan.status, "draft");
    assert.equal(ok.body.plan.divisionApproval, null);
    assert.equal(ok.body.plan.finalApproval.ownerBy, null);
    assert.equal(ok.body.plan.finalApproval.leadBy, null);
    assert.equal(ok.body.plan.editRequest, null);
    assert.equal((await act(admin, plan.id, "edit-request/approve")).status, 400, "대기 요청이 없으면 400");
  });

  await t.test("수정요청 반려: 계획은 잠긴 채 요청만 제거된다", async () => {
    const p4 = await newPlan(tok.memA, "영업1팀 반려테스트");
    assert.equal((await act(tok.dirA, p4.id, "approve-division")).status, 200);
    assert.equal((await act(tok.memA, p4.id, "request-edit", { reason: "재검토" })).status, 200);
    const rej = await act(admin, p4.id, "edit-request/reject");
    assert.equal(rej.status, 200);
    assert.equal(rej.body.plan.status, "divisionApproved");
    assert.equal(rej.body.plan.editRequest, null);
  });

  await t.test("재오픈된 draft는 팀원이 다시 수정·삭제할 수 있다", async () => {
    const put = await api(`${B}/${plan.id}`, auth(tok.memA, "PUT", { name: "수정됨", baseYear: 2027, years: 1, planType: "costOnly" }));
    assert.equal(put.status, 200);
    assert.equal((await api(`${B}/${plan.id}`, auth(tok.memA, "DELETE"))).status, 200);
  });
});
