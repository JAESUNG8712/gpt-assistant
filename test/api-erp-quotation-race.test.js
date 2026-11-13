"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer, bootstrapAdminAndLogin } = require("./support/start-server");

function auth(token, method, body) {
  return {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

test("ERP 견적 상태 전이 경합은 원자적으로 한 요청만 반영한다", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const api = (path, options) => fetch(server.baseUrl + path, options);
  const { token } = await bootstrapAdminAndLogin(server, { loginId: "quote-race-admin", pw: "quote-race-test-pw", name: "견적 경합 관리자" });
  const item = await (await api("/api/erp/items", auth(token, "POST", { code: "RACE-ITEM", name: "경합품목", unit: "EA" }))).json();
  assert.equal(item.ok, true);

  await t.test("accept/reject 동시 요청은 하나만 성공하고 최종 상태가 덮어써지지 않는다", async () => {
    const created = await (await api("/api/erp/quotations", auth(token, "POST", {
      date: "2031-07-01", partnerName: "동시전이거래처",
      items: [{ itemId: item.item.id, name: item.item.name, qty: 1, unitPrice: 1000 }],
    }))).json();
    const id = created.quotation.id;
    assert.equal((await api(`/api/erp/quotations/${id}/send`, auth(token, "POST", {}))).status, 200);
    const [accepted, rejected] = await Promise.all([
      api(`/api/erp/quotations/${id}/accept`, auth(token, "POST", {})),
      api(`/api/erp/quotations/${id}/reject`, auth(token, "POST", { reason: "동시 반려" })),
    ]);
    assert.deepEqual([accepted.status, rejected.status].sort((a, b) => a - b), [200, 400]);
    const list = await (await api("/api/erp/quotations", { headers: { Authorization: `Bearer ${token}` } })).json();
    const final = list.quotations.find(q => q.id === id);
    assert.ok(["accepted", "rejected"].includes(final.status));
    if (final.status === "accepted") assert.equal(final.rejectReason, undefined);
    else assert.equal(final.acceptedAt, undefined);
  });

  await t.test("동일 품목 합산 출고와 창고별 잔고", () => require("./support/erp-shipment-stock")(api, token));

  await t.test("draft 삭제와 발송 경합은 성공 하나만 남긴다", async () => {
    const created = await (await api("/api/erp/quotations", auth(token, "POST", {
      date: "2031-07-02", partnerName: "삭제경합거래처",
      items: [{ itemId: item.item.id, name: item.item.name, qty: 1, unitPrice: 2000 }],
    }))).json();
    const id = created.quotation.id;
    const [sent, deleted] = await Promise.all([
      api(`/api/erp/quotations/${id}/send`, auth(token, "POST", {})),
      api(`/api/erp/quotations/${id}`, auth(token, "DELETE")),
    ]);
    assert.equal([sent.status, deleted.status].filter(status => status === 200).length, 1);
    assert.ok([400, 404].includes(sent.status === 200 ? deleted.status : sent.status));
    const list = await (await api("/api/erp/quotations", { headers: { Authorization: `Bearer ${token}` } })).json();
    const final = list.quotations.find(q => q.id === id);
    if (sent.status === 200) assert.equal(final.status, "sent");
    else assert.equal(final, undefined);
  });
});
