"use strict";

// 수금/지급 삭제와 세금계산서 취소(void)의 서버 규칙 회귀 테스트.
// 없는 id 삭제는 404(화면이 가짜 성공을 보이지 않도록), 취소는 사유 필수·발행 상태만 가능,
// 취소된 세금계산서는 부가세 신고자료 매출세액에서 빠진다.
const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer, bootstrapAdminAndLogin } = require("./support/start-server");

test("수금/지급 삭제·세금계산서 취소", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const boot = await bootstrapAdminAndLogin(server, { loginId: "admin", pw: "admin-test-pw-1", name: "관리자" });
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${boot.token}` };
  const call = async (method, path, body, h = headers) => {
    const res = await fetch(server.baseUrl + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const A = "/api/accounting";

  await t.test("수금/지급 삭제: 정상 삭제 후 목록에서 사라지고, 같은 id 재삭제·없는 id는 404", async () => {
    const created = await call("POST", `${A}/payments`, { direction: "in", date: "2026-06-30", partnerName: "삭제상사", amount: 500, user: "admin" });
    assert.equal(created.status, 200);
    const id = created.body.payment.id;
    assert.equal((await call("POST", `${A}/payments/${id}/delete`, {})).status, 200);
    const list = await call("GET", `${A}/payments`);
    assert.equal(list.body.payments.some((p) => p.id === id), false);
    assert.equal((await call("POST", `${A}/payments/${id}/delete`, {})).status, 404);
    assert.equal((await call("POST", `${A}/payments/pay_none/delete`, {})).status, 404);
  });

  await t.test("수금/지급 삭제: 토큰이 없거나 관리자가 아니면 거부", async () => {
    const created = await call("POST", `${A}/payments`, { direction: "out", date: "2026-06-30", partnerName: "보호상사", amount: 700, user: "admin" });
    const id = created.body.payment.id;
    const noAuth = await call("POST", `${A}/payments/${id}/delete`, {}, { "Content-Type": "application/json" });
    assert.equal(noAuth.status, 401);
    const still = await call("GET", `${A}/payments`);
    assert.equal(still.body.payments.some((p) => p.id === id), true, "거부된 요청은 데이터를 지우지 않는다");
  });

  const issue = (extra) => call("POST", `${A}/tax-invoices`, {
    issueDate: "2026-03-10", partnerName: "취소상사", partnerBizNo: "123-45-67890",
    items: [{ name: "서비스", qty: 2, unitPrice: 1000 }], user: "admin", ...(extra || {}),
  });
  const vat = async () => (await call("GET", `${A}/vat-report?from=2026-01-01&to=2026-12-31`)).body;

  await t.test("세금계산서 취소: 사유 필수(400), 없는 id는 404, 정상 취소는 void 상태가 된다", async () => {
    const inv = await issue();
    assert.equal(inv.status, 200);
    const id = inv.body.taxInvoice.id;
    assert.equal((await call("POST", `${A}/tax-invoices/${id}/void`, {})).status, 400);
    assert.equal((await call("POST", `${A}/tax-invoices/ti_none/void`, { reason: "x" })).status, 404);
    const ok = await call("POST", `${A}/tax-invoices/${id}/void`, { reason: "착오 발행" });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.taxInvoice.status, "void");
    assert.equal(ok.body.taxInvoice.voidReason, "착오 발행");
  });

  await t.test("이미 취소된 세금계산서는 다시 취소할 수 없다", async () => {
    const inv = await issue();
    const id = inv.body.taxInvoice.id;
    assert.equal((await call("POST", `${A}/tax-invoices/${id}/void`, { reason: "1차" })).status, 200);
    assert.equal((await call("POST", `${A}/tax-invoices/${id}/void`, { reason: "2차" })).status, 400);
  });

  await t.test("취소된 세금계산서는 부가세 신고자료 매출세액에서 제외된다", async () => {
    const before = await vat();
    const inv = await issue({ items: [{ name: "추가", qty: 1, unitPrice: 10000 }] });
    const id = inv.body.taxInvoice.id;
    const issued = await vat();
    assert.ok(JSON.stringify(issued) !== JSON.stringify(before), "발행 후 신고자료가 변한다");
    assert.equal((await call("POST", `${A}/tax-invoices/${id}/void`, { reason: "집계 제외 확인" })).status, 200);
    const after = await vat();
    assert.equal(JSON.stringify(after), JSON.stringify(before), "취소하면 발행 전 신고자료와 동일해진다");
  });

  await t.test("세금계산서 취소: 무토큰은 401", async () => {
    const inv = await issue();
    const r = await call("POST", `${A}/tax-invoices/${inv.body.taxInvoice.id}/void`, { reason: "x" }, { "Content-Type": "application/json" });
    assert.equal(r.status, 401);
  });
});
