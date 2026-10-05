"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer, bootstrapAdminAndLogin } = require("./support/start-server");

test("관리자 운영센터 — 로그인 보안 이력과 감사 주체를 서버가 보장한다", async t => {
  const server = await startServer();
  t.after(() => server.stop());
  const api = (path, options) => fetch(server.baseUrl + path, options);
  const admin = await bootstrapAdminAndLogin(server, { loginId: "ops-admin", pw: "ops-admin-password", name: "운영 관리자" });
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${admin.token}` };

  await t.test("성공·실패 로그인 이력이 남고 실패 아이디 원문은 저장하지 않는다", async () => {
    const failed = await (await api("/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ loginId: "sensitive-user", pw: "wrong-password" }) })).json();
    assert.equal(failed.ok, false);
    const activity = await (await api("/activity?limit=1000", { headers })).json();
    assert.equal(activity.ok, true);
    assert.equal(activity.logs.some(row => row.action === "login_succeeded" && row.userName === "운영 관리자"), true);
    const failedRow = activity.logs.find(row => row.action === "login_failed");
    assert.ok(failedRow);
    assert.notEqual(failedRow.userName, "sensitive-user");
    assert.match(failedRow.userName, /^se\*+$/);
  });

  await t.test("POST /log의 사용자명 위조를 무시하고 토큰 주체로 기록한다", async () => {
    const response = await api("/log", { method: "POST", headers, body: JSON.stringify({ userId: "ceo", userName: "대표이사 위조", action: "menu_opened", target: "admin-operations", detail: "메뉴 진입" }) });
    assert.equal(response.status, 200);
    const activity = await (await api("/activity?limit=1000", { headers })).json();
    const row = activity.logs.find(item => item.action === "menu_opened" && item.target === "admin-operations");
    assert.ok(row);
    assert.equal(row.userName, "운영 관리자");
    assert.equal(row.userId, `emp:${admin.employee.id}`);
  });

  await t.test("제어문자를 정리하고 과도한 조회 한도를 제한한다", async () => {
    const invalid = await api("/log", { method: "POST", headers, body: JSON.stringify({ action: "menu\nforged", target: "x" }) });
    assert.equal(invalid.status, 200);
    const capped = await (await api("/activity?limit=999999", { headers })).json();
    assert.equal(capped.ok, true);
    assert.ok(capped.logs.length <= 1000);
    assert.equal(capped.logs.some(row => String(row.action).includes("\n")), false);
  });

  await t.test("무인증 사용자는 운영 이력을 조회할 수 없다", async () => {
    assert.equal((await api("/activity?limit=10")).status, 401);
  });
});
