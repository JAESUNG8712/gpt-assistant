"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer, bootstrapAdminAndLogin } = require("./support/start-server");

test("직원 몰입도 펄스는 본인 응답만 쓰고 3명 이상일 때만 익명 집계한다", async t => {
  const server = await startServer();
  t.after(() => server.stop());
  const api = (path, opts) => fetch(server.baseUrl + path, opts);
  const boot = await bootstrapAdminAndLogin(server, { loginId: "pulse_admin", pw: "pulse_admin_pw", name: "펄스관리자" });
  const auth = token => ({ "Content-Type": "application/json", Authorization: `Bearer ${token}` });
  const members = [1, 2, 3].map(n => ({ id: `pulse-m${n}`, loginId: `pulse_m${n}`, pw: `pulse_pw${n}`, role: "member", name: `펄스직원${n}`, empNo: `P${n}`, dept: "개발본부", team: "제품팀", active: true }));

  let state = await (await api("/data", { headers: auth(boot.token) })).json();
  let saved = await api("/save", { method: "POST", headers: auth(boot.token), body: JSON.stringify({ _version: state.version, data: { employees: [boot.employee, ...members], engagementSurveys: [], engagementResponses: [] } }) });
  assert.equal(saved.status, 200);

  const login = async m => {
    const res = await api("/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ loginId: m.loginId, pw: m.pw }) });
    const json = await res.json(); assert.equal(json.ok, true); return json.token;
  };
  const tokens = [];
  for (const member of members) tokens.push(await login(member));

  state = await (await api("/data", { headers: auth(boot.token) })).json();
  const survey = { id: "pulse-2026-10", title: "10월 몰입도", startDate: "2026-10-01", endDate: "2026-10-31", status: "open", questions: [{ id: "engagement", driver: "몰입", text: "추천 의향" }, { id: "growth", driver: "성장", text: "성장 체감" }, { id: "action", driver: "실행 신뢰", text: "개선 조치 신뢰" }] };
  saved = await api("/save", { method: "POST", headers: auth(boot.token), body: JSON.stringify({ _version: state.version, data: { engagementSurveys: [survey] } }) });
  assert.equal(saved.status, 200);

  for (let i = 0; i < members.length; i++) {
    const token = tokens[i];
    const mine = await (await api("/data", { headers: auth(token) })).json();
    const response = { id: `resp-${i + 1}`, surveyId: survey.id, empId: i === 0 ? "another-user" : members[i].id, scores: { engagement: 7 + i, growth: 6 + i, action: 5 + i }, comment: `익명 의견 ${i + 1}` };
    const write = await api("/save", { method: "POST", headers: auth(token), body: JSON.stringify({ _version: mine.version, data: { engagementResponses: [response], engagementSurveys: [{ ...survey, title: "직원이 위조한 설문" }] } }) });
    assert.equal(write.status, 200);

    const selfView = await (await api("/data", { headers: auth(token) })).json();
    assert.equal(selfView.data.engagementResponses.length, 1);
    assert.equal(String(selfView.data.engagementResponses[0].empId), members[i].id, "서버가 응답자 ID를 로그인 사용자로 고정해야 함");
    assert.equal(selfView.data.engagementSurveys[0].title, "10월 몰입도", "직원이 설문 원본을 수정하면 안 됨");

    const adminView = await (await api("/data", { headers: auth(boot.token) })).json();
    assert.deepEqual(adminView.data.engagementResponses, [], "관리자에게도 개인 응답 원본을 제공하면 안 됨");
    const summary = adminView.data.engagementPulseSummary[survey.id];
    assert.equal(summary.responseCount, i + 1);
    assert.equal(summary.thresholdMet, i + 1 >= 3);
    if (i < 2) {
      assert.deepEqual(summary.driverAverages, {});
      assert.deepEqual(summary.comments, []);
    } else {
      assert.equal(summary.driverAverages.engagement, 8);
      assert.deepEqual(summary.comments, ["익명 의견 1", "익명 의견 2", "익명 의견 3"]);
    }
  }

  const beforeClose = await (await api("/data", { headers: auth(boot.token) })).json();
  const close = await api("/save", { method: "POST", headers: auth(boot.token), body: JSON.stringify({ _version: beforeClose.version, data: { engagementSurveys: [{ ...survey, status: "closed", closedAt: new Date().toISOString() }] } }) });
  assert.equal(close.status, 200);
  const memberAfterClose = await (await api("/data", { headers: auth(tokens[0]) })).json();
  const altered = { ...memberAfterClose.data.engagementResponses[0], scores: { engagement: 0 }, comment: "마감 후 변조" };
  const lateWrite = await api("/save", { method: "POST", headers: auth(tokens[0]), body: JSON.stringify({ _version: memberAfterClose.version, data: { engagementResponses: [altered] } }) });
  assert.equal(lateWrite.status, 200);
  const afterLateWrite = await (await api("/data", { headers: auth(boot.token) })).json();
  assert.equal(afterLateWrite.data.engagementPulseSummary[survey.id].driverAverages.engagement, 8, "마감 뒤 응답 수정은 집계에 반영되면 안 됨");
  assert.equal(afterLateWrite.data.engagementPulseSummary[survey.id].comments.includes("마감 후 변조"), false);

  const action = { id: "pulse-action-1", surveyId: survey.id, title: "주간 우선순위 공유", dueDate: "2026-11-30", status: "open" };
  const actionWrite = await api("/save", { method: "POST", headers: auth(boot.token), body: JSON.stringify({ _version: afterLateWrite.version, data: { engagementActions: [action] } }) });
  assert.equal(actionWrite.status, 200);
  const memberWithAction = await (await api("/data", { headers: auth(tokens[0]) })).json();
  assert.equal(memberWithAction.data.engagementActions[0].title, "주간 우선순위 공유", "전사 개선계획은 직원에게 공개되어야 함");
  const forgedAction = { ...memberWithAction.data.engagementActions[0], title: "직원이 변조", status: "done" };
  const forgedWrite = await api("/save", { method: "POST", headers: auth(tokens[0]), body: JSON.stringify({ _version: memberWithAction.version, data: { engagementActions: [forgedAction] } }) });
  assert.equal(forgedWrite.status, 200);
  const finalAdmin = await (await api("/data", { headers: auth(boot.token) })).json();
  assert.equal(finalAdmin.data.engagementActions[0].title, "주간 우선순위 공유");
  assert.equal(finalAdmin.data.engagementActions[0].status, "open");
});
