"use strict";

// 포지션 신설·증원 요청의 권한, 예산 확인, CAS, 원자적 정원 반영 회귀 테스트.
// 임시 JSON 저장소와 랜덤 포트만 사용하므로 운영 DB/운영 인사자료는 변경하지 않는다.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { startServer, bootstrapAdminAndLogin } = require("./support/start-server");

function auth(token, method, body) {
  return { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) };
}
async function login(api, loginId, pw) {
  const body = await (await api("/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ loginId, pw }) })).json();
  assert.equal(body.ok, true, JSON.stringify(body));
  return body.token;
}
async function data(api, token) {
  const body = await (await api("/data", { headers: { Authorization: `Bearer ${token}` } })).json();
  assert.equal(body.ok, true, JSON.stringify(body));
  return body;
}

test("정원 신설·증원 요청 — 예산 승인, 조직 범위, 이중 반영 방지", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const api = (path, options) => fetch(server.baseUrl + path, options);
  const { token: adminToken } = await bootstrapAdminAndLogin(server, { loginId: "position-approval-admin", pw: "position-approval-admin-pw", name: "정원 승인 관리자" });
  const initial = await data(api, adminToken);
  const adminId = initial.data.employees.find(e => e.loginId === "position-approval-admin").id;
  const now = new Date().toISOString();
  const leader = { id: "position-leader", loginId: "position-leader", pw: "position-leader-pw", name: "ERP팀장", role: "leader", active: true, dept: "DX사업본부", team: "ERP팀", menuPerms: {} };
  const member = { id: "position-member", loginId: "position-member", pw: "position-member-pw", name: "ERP팀원", role: "member", active: true, dept: "DX사업본부", team: "ERP팀", menuPerms: {} };
  const positions = [
    { id: "position-existing", code: "POS-DX-ERP-001", title: "ERP 컨설턴트", dept: "DX사업본부", team: "ERP팀", targetHeadcount: 2, incumbentIds: [], positionType: "regular", status: "active", createdAt: now, updatedAt: now },
    { id: "position-other-team", code: "POS-DX-DEV-001", title: "개발자", dept: "DX사업본부", team: "개발팀", targetHeadcount: 3, incumbentIds: [], positionType: "regular", status: "active", createdAt: now, updatedAt: now },
    { id: "position-other-dept", code: "POS-HR-001", title: "HRBP", dept: "경영지원본부", team: "인사팀", targetHeadcount: 1, incumbentIds: [], positionType: "regular", status: "active", createdAt: now, updatedAt: now },
  ];
  const seeded = await api("/save", auth(adminToken, "POST", { _version: initial.version, data: { ...initial.data, employees: [...initial.data.employees, leader, member], workforcePositions: positions } }));
  assert.equal(seeded.status, 200, await seeded.text());
  const leaderToken = await login(api, leader.loginId, leader.pw);
  const memberToken = await login(api, member.loginId, member.pw);

  // 실제 운영 예산과 같은 별도 budget 저장소에 최종확정 사업계획을 준비한다. 요청 승인
  // 테스트는 이 원본을 직접 수정하지 않고 승인된 positionRequests를 사용액으로 합산한다.
  fs.writeFileSync(server.budgetDataFile, JSON.stringify({ _legacy: {
    headcount: [], items: [], uploads: [], budgetPlanSettings: { ownerIds: [], teamLeaderId: null, inputOpen: true },
    businessPlans: [{
      id: "plan-dx-2027", name: "DX사업본부 2027 인력계획", baseYear: 2027, years: 1,
      dept: "DX사업본부", team: "ERP팀", status: "finalConfirmed",
      assumptions: { sgaItems: [
        { name: "신규 인력 인건비", detail: "ERP PM", category: "급여", accountType: "판관", baseAmount: 200000000 },
        { name: "증원 인건비", detail: "ERP 컨설턴트", category: "급여", accountType: "판관", baseAmount: 100000000 },
      ] },
    }, {
      id: "plan-other-2027", name: "경영지원본부 2027 인력계획", baseYear: 2027, years: 1,
      dept: "경영지원본부", team: "인사팀", status: "finalConfirmed",
      assumptions: { sgaItems: [{ name: "HR 인건비", category: "급여", baseAmount: 90000000 }] },
    }, {
      id: "plan-draft-2027", name: "미확정 계획", baseYear: 2027, years: 1,
      dept: "DX사업본부", team: "ERP팀", status: "draft",
      assumptions: { sgaItems: [{ name: "미확정 인건비", category: "급여", baseAmount: 999000000 }] },
    }],
  } }, null, 2));
  const budgetPickerResponse = await api("/api/workforce/position-budget-items/picker", { headers: { Authorization: `Bearer ${leaderToken}` } });
  assert.equal(budgetPickerResponse.status, 200);
  const budgetPicker = (await budgetPickerResponse.json()).items;
  assert.equal(budgetPicker.length, 2, "팀장은 자기 팀의 최종확정 예산 항목만 조회해야 한다");
  const newBudget = budgetPicker.find(x => x.itemName === "신규 인력 인건비");
  const increaseBudget = budgetPicker.find(x => x.itemName === "증원 인건비");
  assert.ok(newBudget && increaseBudget);
  const adminBudgetPicker = (await (await api("/api/workforce/position-budget-items/picker", { headers: { Authorization: `Bearer ${adminToken}` } })).json()).items;
  const otherOrgBudget = adminBudgetPicker.find(x => x.businessPlanId === "plan-other-2027");
  assert.ok(otherOrgBudget);
  const link = item => ({ businessPlanId: item.businessPlanId, budgetItemKey: item.budgetItemKey, budgetPlanName: item.planName, budgetPlanYear: item.baseYear, budgetItemName: item.itemName });

  await t.test("팀장 포지션 선택기는 자기 팀 최소 정보만 반환한다", async () => {
    const r = await api("/api/workforce/positions/picker", { headers: { Authorization: `Bearer ${leaderToken}` } });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.deepEqual(body.positions.map(p => p.id), ["position-existing"]);
    assert.equal(Object.hasOwn(body.positions[0], "incumbentIds"), false);
    assert.deepEqual(budgetPicker.map(x => x.itemName).sort(), ["신규 인력 인건비", "증원 인건비"]);
  });

  const requestId = "position-request-new";
  await t.test("팀장이 상태·요청자를 위조해 저장해도 본인 초안으로 강제된다", async () => {
    const view = await data(api, leaderToken);
    assert.deepEqual(view.data.workforcePositions, []);
    const forged = { id: requestId, requestType: "new", positionCode: "POS-DX-ERP-002", title: "ERP PM", dept: "DX사업본부", team: "ERP팀", headcount: 2, estimatedAnnualCost: 160000000, budgetSource: "2027 사업계획 인건비", costCenter: "CC-DX-ERP", justification: "확정 수주 프로젝트 동시 수행", positionType: "regular", effectiveDate: "2027-01-01", ...link(newBudget), status: "approved", requestedBy: "someone-else", requestedByName: "위조 관리자", createdAt: now, updatedAt: now };
    const r = await api("/save", auth(leaderToken, "POST", { _version: view.version, data: { ...view.data, positionRequests: [forged] } }));
    assert.equal(r.status, 200, await r.clone().text());
    const request = (await data(api, leaderToken)).data.positionRequests.find(x => x.id === requestId);
    assert.ok(request);
    assert.equal(request.status, "draft");
    assert.equal(request.requestedBy, leader.id);
    assert.equal(request.requestedByName, leader.name);
  });

  await t.test("일반 직원은 직접 저장과 전용 조회를 모두 우회할 수 없다", async () => {
    const view = await data(api, memberToken);
    const forged = { id: "member-forged", requestType: "new", positionCode: "POS-FORGED", title: "위조", dept: "DX사업본부", headcount: 1, estimatedAnnualCost: 1, budgetSource: "위조", justification: "위조", status: "draft", requestedBy: member.id, updatedAt: now };
    const write = await api("/save", auth(memberToken, "POST", { _version: view.version, data: { positionRequests: [forged] } }));
    assert.equal(write.status, 200);
    assert.equal((await api("/api/workforce/positions/picker", { headers: { Authorization: `Bearer ${memberToken}` } })).status, 403);
    assert.equal((await api("/api/workforce/position-budget-items/picker", { headers: { Authorization: `Bearer ${memberToken}` } })).status, 403);
    assert.equal((await data(api, adminToken)).data.positionRequests.some(x => x.id === "member-forged"), false);
  });

  await t.test("API에 타 조직이나 숨겨진 포지션 ID를 직접 넣어도 제출할 수 없다", async () => {
    const view = await data(api, leaderToken);
    const cross = { id: "cross-org-request", requestType: "increase", existingPositionId: "position-other-dept", title: "HRBP", dept: "경영지원본부", team: "인사팀", headcount: 1, estimatedAnnualCost: 50000000, budgetSource: "타 조직 예산", justification: "권한 우회 시도", positionType: "regular", effectiveDate: "2027-01-01", ...link(newBudget), status: "draft", requestedBy: leader.id, requestedByName: leader.name, createdAt: now, updatedAt: new Date().toISOString() };
    const saved = await api("/save", auth(leaderToken, "POST", { _version: view.version, data: { ...view.data, positionRequests: [...view.data.positionRequests, cross] } }));
    assert.equal(saved.status, 200, await saved.text());
    const stored = (await data(api, leaderToken)).data.positionRequests.find(x => x.id === cross.id);
    const submit = await api(`/api/workforce/position-requests/${cross.id}/transition`, auth(leaderToken, "POST", { action: "submit", expectedUpdatedAt: stored.updatedAt }));
    assert.equal(submit.status, 403);
    assert.equal((await submit.json()).code, "POSITION_REQUEST_ORG_FORBIDDEN");
  });

  await t.test("자기 조직 요청에 타 조직 예산 키를 직접 주입해도 제출할 수 없다", async () => {
    const view = await data(api, leaderToken);
    const forged = { id: "cross-budget-request", requestType: "new", positionCode: "POS-DX-ERP-XB", title: "예산 우회", dept: "DX사업본부", team: "ERP팀", headcount: 1, estimatedAnnualCost: 40000000, budgetSource: "타 조직 예산", justification: "예산 IDOR 검증", positionType: "regular", effectiveDate: "2027-01-01", ...link(otherOrgBudget), status: "draft", requestedBy: leader.id, requestedByName: leader.name, createdAt: now, updatedAt: new Date().toISOString() };
    const saved = await api("/save", auth(leaderToken, "POST", { _version: view.version, data: { ...view.data, positionRequests: [...view.data.positionRequests, forged] } }));
    assert.equal(saved.status, 200, await saved.text());
    const stored = (await data(api, leaderToken)).data.positionRequests.find(x => x.id === forged.id);
    const submit = await api(`/api/workforce/position-requests/${forged.id}/transition`, auth(leaderToken, "POST", { action: "submit", expectedUpdatedAt: stored.updatedAt }));
    assert.equal(submit.status, 409);
    assert.equal((await submit.json()).code, "POSITION_REQUEST_BUDGET_UNAVAILABLE");
  });

  let submitted;
  await t.test("소유 팀장만 제출할 수 있고 제출 후 전체 저장으로 수정할 수 없다", async () => {
    const view = await data(api, leaderToken);
    const draft = view.data.positionRequests.find(x => x.id === requestId);
    const r = await api(`/api/workforce/position-requests/${requestId}/transition`, auth(leaderToken, "POST", { action: "submit", expectedUpdatedAt: draft.updatedAt }));
    assert.equal(r.status, 200, await r.clone().text());
    submitted = (await r.json()).request;
    assert.equal(submitted.status, "submitted");

    const after = await data(api, leaderToken);
    const attempted = after.data.positionRequests.map(x => x.id === requestId ? { ...x, headcount: 999, status: "approved", updatedAt: new Date().toISOString() } : x);
    const save = await api("/save", auth(leaderToken, "POST", { _version: after.version, data: { ...after.data, positionRequests: attempted } }));
    assert.equal(save.status, 200, await save.text());
    const protectedRequest = (await data(api, adminToken)).data.positionRequests.find(x => x.id === requestId);
    assert.equal(protectedRequest.status, "submitted");
    assert.equal(protectedRequest.headcount, 2);
  });

  await t.test("팀장은 승인할 수 없고 관리자는 예산 확인 없이 승인할 수 없다", async () => {
    const leaderApprove = await api(`/api/workforce/position-requests/${requestId}/transition`, auth(leaderToken, "POST", { action: "approve", expectedUpdatedAt: submitted.updatedAt, budgetConfirmed: true, budgetReference: "BP-1" }));
    assert.equal(leaderApprove.status, 403);
    const adminApprove = await api(`/api/workforce/position-requests/${requestId}/transition`, auth(adminToken, "POST", { action: "approve", expectedUpdatedAt: submitted.updatedAt }));
    assert.equal(adminApprove.status, 400);
    assert.equal((await adminApprove.json()).code, "POSITION_REQUEST_BUDGET_REQUIRED");
  });

  await t.test("관리자 승인과 신규 포지션 생성이 한 번만 원자적으로 반영된다", async () => {
    const r = await api(`/api/workforce/position-requests/${requestId}/transition`, auth(adminToken, "POST", { action: "approve", expectedUpdatedAt: submitted.updatedAt, budgetConfirmed: true, budgetReference: "BP-HR-2027-03", comment: "예산 승인 확인" }));
    assert.equal(r.status, 200, await r.clone().text());
    const approved = await r.json();
    assert.equal(approved.request.status, "approved");
    assert.equal(approved.position.targetHeadcount, 2);
    const replay = await api(`/api/workforce/position-requests/${requestId}/transition`, auth(adminToken, "POST", { action: "approve", expectedUpdatedAt: submitted.updatedAt, budgetConfirmed: true, budgetReference: "BP-HR-2027-03" }));
    assert.equal(replay.status, 409);
    assert.equal((await data(api, adminToken)).data.workforcePositions.filter(p => p.sourceRequestId === requestId).length, 1);
  });

  await t.test("증원 승인도 기존 포지션 정원을 정확히 한 번만 증가시킨다", async () => {
    const leaderView = await data(api, leaderToken);
    const increaseId = "position-request-increase";
    const increase = { id: increaseId, requestType: "increase", existingPositionId: "position-existing", title: "ERP 컨설턴트", dept: "DX사업본부", team: "ERP팀", headcount: 1, estimatedAnnualCost: 70000000, budgetSource: "2027 증원예산", justification: "프로젝트 추가 수주", positionType: "regular", effectiveDate: "2027-01-01", ...link(increaseBudget), status: "draft", requestedBy: leader.id, requestedByName: leader.name, createdAt: now, updatedAt: new Date().toISOString() };
    const saved = await api("/save", auth(leaderToken, "POST", { _version: leaderView.version, data: { ...leaderView.data, positionRequests: [...leaderView.data.positionRequests, increase] } }));
    assert.equal(saved.status, 200, await saved.text());
    const draft = (await data(api, leaderToken)).data.positionRequests.find(x => x.id === increaseId);
    const submit = await api(`/api/workforce/position-requests/${increaseId}/transition`, auth(leaderToken, "POST", { action: "submit", expectedUpdatedAt: draft.updatedAt }));
    assert.equal(submit.status, 200, await submit.clone().text());
    const submittedIncrease = (await submit.json()).request;
    const approve = await api(`/api/workforce/position-requests/${increaseId}/transition`, auth(adminToken, "POST", { action: "approve", expectedUpdatedAt: submittedIncrease.updatedAt, budgetConfirmed: true, budgetReference: "BP-INCREASE-1" }));
    assert.equal(approve.status, 200, await approve.text());
    assert.equal((await data(api, adminToken)).data.workforcePositions.find(p => p.id === "position-existing").targetHeadcount, 3);
  });

  await t.test("동일 잔여예산에 대한 동시 승인은 정확히 하나만 성공한다", async () => {
    const view = await data(api, adminToken);
    const drafts = ["a", "b"].map((suffix, i) => ({
      id: `budget-race-${suffix}`, requestType: "new", positionCode: `POS-BUDGET-${suffix.toUpperCase()}`,
      title: `예산 경합 ${suffix}`, dept: "DX사업본부", team: "ERP팀", headcount: 1,
      estimatedAnnualCost: 30000000, budgetSource: "2027 확정 사업계획", justification: "동시 승인 경합 검증",
      positionType: "regular", effectiveDate: "2027-01-01", ...link(newBudget), status: "draft",
      requestedBy: adminId, requestedByName: "정원 승인 관리자", createdAt: now,
      updatedAt: new Date(Date.now() + i + 10).toISOString(),
    }));
    const saved = await api("/save", auth(adminToken, "POST", { _version: view.version, data: { ...view.data, positionRequests: [...view.data.positionRequests, ...drafts] } }));
    assert.equal(saved.status, 200, await saved.text());
    const current = await data(api, adminToken);
    const submittedRace = [];
    for (const draft of drafts) {
      const stored = current.data.positionRequests.find(x => x.id === draft.id);
      const submittedResponse = await api(`/api/workforce/position-requests/${draft.id}/transition`, auth(adminToken, "POST", { action: "submit", expectedUpdatedAt: stored.updatedAt }));
      assert.equal(submittedResponse.status, 200, await submittedResponse.clone().text());
      submittedRace.push((await submittedResponse.json()).request);
    }
    const approvals = await Promise.all(submittedRace.map(r => api(`/api/workforce/position-requests/${r.id}/transition`, auth(adminToken, "POST", { action: "approve", expectedUpdatedAt: r.updatedAt, budgetConfirmed: true, budgetReference: "BP-RACE-2027" }))));
    assert.deepEqual(approvals.map(r => r.status).sort(), [200, 409]);
    const failed = approvals.find(r => r.status === 409);
    assert.equal((await failed.json()).code, "POSITION_REQUEST_BUDGET_EXCEEDED");
    const latestPicker = await (await api("/api/workforce/position-budget-items/picker", { headers: { Authorization: `Bearer ${adminToken}` } })).json();
    const latestNewBudget = latestPicker.items.find(x => x.businessPlanId === newBudget.businessPlanId && x.budgetItemKey === newBudget.budgetItemKey);
    assert.equal(latestNewBudget.committedAmount, 190000000);
    assert.equal(latestNewBudget.remainingAmount, 10000000);
  });

  await t.test("비관리자 응답에는 자기 요청만 남고 다른 사람 요청은 노출되지 않는다", async () => {
    const adminView = await data(api, adminToken);
    const adminRequest = { id: "admin-private-request", requestType: "new", positionCode: "POS-ADMIN-001", title: "관리자 전용 요청", dept: "경영지원본부", team: "인사팀", headcount: 1, estimatedAnnualCost: 60000000, budgetSource: "관리자 예산", justification: "관리자 요청", status: "draft", requestedBy: adminId, requestedByName: "정원 승인 관리자", createdAt: now, updatedAt: now };
    const saved = await api("/save", auth(adminToken, "POST", { _version: adminView.version, data: { ...adminView.data, positionRequests: [...adminView.data.positionRequests, adminRequest] } }));
    assert.equal(saved.status, 200, await saved.text());
    const leaderView = await data(api, leaderToken);
    assert.equal(leaderView.data.positionRequests.some(x => x.id === "admin-private-request"), false);
    assert.equal(leaderView.data.positionRequests.every(x => String(x.requestedBy) === leader.id), true);
    const roundTrip = await api("/save", auth(leaderToken, "POST", { _version: leaderView.version, data: { ...leaderView.data } }));
    assert.equal(roundTrip.status, 200, await roundTrip.text());
    assert.equal((await data(api, adminToken)).data.positionRequests.some(x => x.id === "admin-private-request"), true, "필터링된 비관리자 저장이 타인 요청을 삭제하면 안 된다");
  });
});
