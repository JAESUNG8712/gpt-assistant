"use strict";

// RCPS 공정가치평가 입력 검증: fairValue가 숫자가 아니거나 음수, valuationDate 형식 오류는
// 존재하지 않는 발행 건 id(404)보다 먼저 400으로 거부돼야 한다(NaN이 저장되던 결함).
const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer, bootstrapAdminAndLogin } = require("./support/start-server");

test("RCPS 공정가치평가 fairValue/valuationDate 검증", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const boot = await bootstrapAdminAndLogin(server, { loginId: "admin", pw: "admin-test-pw-1", name: "관리자" });
  const post = async (body) => {
    const res = await fetch(server.baseUrl + "/api/accounting/rcps/valuations", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${boot.token}` },
      body: JSON.stringify(body),
    });
    return res.status;
  };
  const base = { issuanceId: "no-such", valuationDate: "2026-06-30", fairValue: 1000, user: "admin" };

  await t.test("정상 값은 검증을 통과해 발행 건 조회 단계(404)까지 간다", async () => {
    assert.equal(await post(base), 404);
  });
  await t.test("숫자가 아닌 fairValue는 400", async () => {
    assert.equal(await post({ ...base, fairValue: "abc" }), 400);
  });
  await t.test("음수 fairValue는 400", async () => {
    assert.equal(await post({ ...base, fairValue: -5 }), 400);
  });
  await t.test("형식이 틀린 valuationDate는 400", async () => {
    assert.equal(await post({ ...base, valuationDate: "2026/06/30" }), 400);
    assert.equal(await post({ ...base, valuationDate: "2026-13-45" }), 400);
  });
});
