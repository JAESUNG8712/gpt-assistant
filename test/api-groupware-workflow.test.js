"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer, bootstrapAdminAndLogin } = require("./support/start-server");

function auth(token, body) { return { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body) }; }
async function login(api, loginId, pw) {
  const r = await (await api("/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ loginId, pw }) })).json();
  assert.equal(r.ok, true); return r.token;
}
async function data(api, token) {
  const r = await (await api("/data", { headers: { Authorization: `Bearer ${token}` } })).json();
  assert.equal(r.ok, true); return r;
}

test("그룹웨어 할일·업무보고 — 소유권, 조직 조회 범위, 필터 저장 보존", async t => {
  const server = await startServer(); t.after(() => server.stop());
  const api = (path, options) => fetch(server.baseUrl + path, options);
  const boot = await bootstrapAdminAndLogin(server, { loginId: "admin", pw: "admin-test-pw-1", name: "관리자" });
  const initial = await data(api, boot.token);
  const employees = [...initial.data.employees,
    { id: "lead-a", loginId: "lead-a", pw: "lead-a-pw-1", name: "A팀장", role: "leader", active: true, dept: "개발", team: "A" },
    { id: "mem-a", loginId: "mem-a", pw: "mem-a-pw-1", name: "A팀원", role: "member", active: true, dept: "개발", team: "A" },
    { id: "mem-b", loginId: "mem-b", pw: "mem-b-pw-1", name: "B팀원", role: "member", active: true, dept: "개발", team: "B" },
    { id: "mem-x", loginId: "mem-x", pw: "mem-x-pw-1", name: "타부서", role: "member", active: true, dept: "영업", team: "X" },
  ];
  assert.equal((await api("/save", auth(boot.token, { _version: initial.version, employees }))).status, 200);
  const tokens = { lead: await login(api, "lead-a", "lead-a-pw-1"), a: await login(api, "mem-a", "mem-a-pw-1"), b: await login(api, "mem-b", "mem-b-pw-1"), x: await login(api, "mem-x", "mem-x-pw-1") };
  async function saveOwn(token, ownerId, dept, team, suffix) {
    const d = await data(api, token), now = new Date().toISOString();
    const body = { _version: d.version,
      personalTasks: [{ id: `task-${suffix}`, ownerId, title: `할일-${suffix}`, status: "todo", createdAt: now, updatedAt: now }],
      workReports: [{ id: `report-${suffix}`, authorId: ownerId, authorName: suffix, dept, team, periodType: "daily", periodStart: "2026-10-02", periodEnd: "2026-10-02", summary: `업무보고-${suffix}`, nextPlan: "다음 계획", status: "submitted", createdAt: now, updatedAt: now }],
    };
    assert.equal((await api("/save", auth(token, body))).status, 200);
  }
  await saveOwn(tokens.a, "mem-a", "개발", "A", "a");
  await saveOwn(tokens.b, "mem-b", "개발", "B", "b");
  await saveOwn(tokens.x, "mem-x", "영업", "X", "x");

  await t.test("개인 할일은 관리자 포함 누구에게도 교차 노출되지 않는다", async () => {
    assert.deepEqual((await data(api, tokens.a)).data.personalTasks.map(x => x.id), ["task-a"]);
    assert.deepEqual((await data(api, tokens.b)).data.personalTasks.map(x => x.id), ["task-b"]);
    assert.deepEqual((await data(api, boot.token)).data.personalTasks, []);
  });
  await t.test("팀장은 같은 팀 업무보고만, 관리자는 전체 업무보고를 본다", async () => {
    assert.deepEqual((await data(api, tokens.lead)).data.workReports.map(x => x.id), ["report-a"]);
    assert.deepEqual(new Set((await data(api, boot.token)).data.workReports.map(x => x.id)), new Set(["report-a", "report-b", "report-x"]));
  });
  await t.test("타인 명의 할일·업무보고 위조는 저장되지 않는다", async () => {
    const d = await data(api, tokens.a), now = new Date().toISOString();
    await api("/save", auth(tokens.a, { _version: d.version,
      personalTasks: [...d.data.personalTasks, { id: "forged-task", ownerId: "mem-b", title: "위조", status: "todo", createdAt: now, updatedAt: now }],
      workReports: [...d.data.workReports, { id: "forged-report", authorId: "mem-b", dept: "개발", team: "B", summary: "위조", nextPlan: "위조", createdAt: now, updatedAt: now }],
    }));
    assert.equal((await data(api, boot.token)).data.workReports.some(x => x.id === "forged-report"), false);
    assert.deepEqual((await data(api, tokens.b)).data.personalTasks.map(x => x.id), ["task-b"]);
  });
  await t.test("기존 타인 레코드 ID의 소유자 바꿔치기와 제출본 수정도 차단한다", async () => {
    const d = await data(api, tokens.a), now = new Date().toISOString();
    await api("/save", auth(tokens.a, { _version: d.version,
      personalTasks: [{ id: "task-b", ownerId: "mem-a", title: "탈취 시도", status: "done", updatedAt: now }],
      workReports: [
        { id: "report-b", authorId: "mem-a", dept: "개발", team: "A", periodStart: "2026-10-02", periodEnd: "2026-10-02", summary: "타인 보고서 탈취", nextPlan: "없음", status: "draft", updatedAt: now },
        { ...d.data.workReports.find(x => x.id === "report-a"), summary: "제출 후 변조", updatedAt: now },
      ],
    }));
    assert.equal((await data(api, tokens.b)).data.personalTasks.find(x => x.id === "task-b").title, "할일-b");
    const adminReports = (await data(api, boot.token)).data.workReports;
    assert.equal(adminReports.find(x => x.id === "report-b").summary, "업무보고-b");
    assert.equal(adminReports.find(x => x.id === "report-a").summary, "업무보고-a");
  });
});
