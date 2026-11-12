"use strict";

// 수금/지급 등록의 일자 형식과 부가세 신고자료의 기간(from/to) 검증.
// 이전에는 payments가 date를 truthy만 확인했고, vat-report는 형식이 틀린 기간을
// Postgres DATE 비교에 그대로 넘겨 500이 될 수 있었다.
const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer, bootstrapAdminAndLogin } = require("./support/start-server");

test("수금/지급 일자·부가세 기간 검증", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const boot = await bootstrapAdminAndLogin(server, { loginId: "admin", pw: "admin-test-pw-1", name: "관리자" });
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${boot.token}` };
  const pay = async (body) => {
    const res = await fetch(server.baseUrl + "/api/accounting/payments", { method: "POST", headers, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const vat = async (qs) => {
    const res = await fetch(server.baseUrl + "/api/accounting/vat-report" + qs, { headers });
    return res.status;
  };
  const base = { direction: "in", date: "2026-06-30", partnerName: "테스트상사", amount: 1000, user: "admin" };

  await t.test("정상 수금 등록은 200", async () => {
    const r = await pay(base);
    assert.equal(r.status, 200);
    assert.equal(r.body.payment.date, "2026-06-30");
  });
  await t.test("형식이 틀린 일자는 400", async () => {
    assert.equal((await pay({ ...base, date: "2026/06/30" })).status, 400);
    assert.equal((await pay({ ...base, date: "아무말" })).status, 400);
  });
  await t.test("존재하지 않는 날짜는 400", async () => {
    assert.equal((await pay({ ...base, date: "2026-02-30" })).status, 400);
    assert.equal((await pay({ ...base, date: "2026-13-01" })).status, 400);
  });
  await t.test("금액 0 이하는 400", async () => {
    assert.equal((await pay({ ...base, amount: 0 })).status, 400);
    assert.equal((await pay({ ...base, amount: -10 })).status, 400);
  });
  await t.test("부가세 신고자료: 정상 기간 200", async () => {
    assert.equal(await vat("?from=2026-01-01&to=2026-06-30"), 200);
  });
  await t.test("부가세 신고자료: 기간 누락/형식오류/역전은 400", async () => {
    assert.equal(await vat("?from=2026-01-01"), 400);
    assert.equal(await vat("?from=2026/01/01&to=2026-06-30"), 400);
    assert.equal(await vat("?from=2026-02-30&to=2026-06-30"), 400);
    assert.equal(await vat("?from=2026-07-01&to=2026-06-30"), 400);
  });
});
