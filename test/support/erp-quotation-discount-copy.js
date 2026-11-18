"use strict";
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");

// 견적서 품목별 할인과 복사를 JSON/PostgreSQL 양쪽에서 같은 계약으로 검증한다.
module.exports = async function checkQuotationDiscountCopy(baseUrl, token, tag = "qd") {
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  async function call(path, body, expected = 200) {
    const res = await fetch(baseUrl + path, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? headers : { ...headers, "Idempotency-Key": randomUUID() },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json();
    assert.equal(res.status, expected, `${path} → ${res.status} ${JSON.stringify(json)}`);
    return json;
  }
  const erp = (p, b, e) => call("/api/erp/" + p, b, e);

  const itemA = (await erp("items", { code: `${tag}-A`, name: "품목A", unit: "EA" })).item.id;
  const itemB = (await erp("items", { code: `${tag}-B`, name: "품목B", unit: "EA" })).item.id;
  const loc = (await erp("locations", { name: `${tag}-창고` })).location.id;
  await erp("stock/adjust", { itemId: itemA, locationId: loc, type: "in", qty: 100 });
  await erp("stock/adjust", { itemId: itemB, locationId: loc, type: "in", qty: 100 });

  const base = {
    date: "2032-03-10", validUntil: "2032-03-20", partnerName: "할인 고객", locationId: loc, memo: "원본 메모",
  };
  // 잘못된 할인율은 거부된다.
  for (const bad of [101, -1, "abc"]) {
    await erp("quotations", { ...base, items: [{ itemId: itemA, qty: 1, unitPrice: 1000, discountRate: bad }] }, 400);
  }

  const q = (await erp("quotations", {
    ...base,
    items: [{ itemId: itemA, qty: 10, unitPrice: 1000, discountRate: 10 }, { itemId: itemB, qty: 4, unitPrice: 5000 }],
  })).quotation;
  assert.equal(q.lines[0].supplyAmount, 9000);
  assert.equal(q.lines[0].discountRate, 10);
  assert.equal(q.lines[1].supplyAmount, 20000);
  assert.equal(q.lines[1].discountRate, undefined, "할인이 없으면 필드를 남기지 않는다");
  assert.equal(q.supplyTotal, 29000);
  assert.equal(q.taxTotal, 2900);
  assert.equal(q.grandTotal, 31900);

  // 발주서는 할인율을 쓰지 않는다(요청에 실려도 무시).
  const po = (await erp("purchase-orders", { date: "2032-03-10", partnerName: "공급사", locationId: loc, items: [{ itemId: itemA, qty: 10, unitPrice: 1000, discountRate: 50 }] })).purchaseOrder;
  assert.equal(po.supplyTotal, 10000);
  assert.equal(po.lines[0].discountRate, undefined);

  // 부분 출고·반품·세금계산서에 할인이 그대로 반영된다.
  const qPath = "quotations/" + q.id;
  await erp(qPath + "/send", {});
  await erp(qPath + "/accept", {});
  const r1 = await erp(qPath + "/ship", { lines: [{ index: 0, qty: 5 }] });
  assert.equal(r1.taxInvoice.supplyTotal, 4500, "5 × 1000 × 0.9");
  assert.equal(r1.taxInvoice.lines[0].discountRate, 10);
  const r2 = await erp(qPath + "/ship", {});
  assert.equal(r2.taxInvoice.supplyTotal, 4500 + 20000);
  const ret = await erp(qPath + "/return", { round: 1, lines: [{ index: 0, qty: 2 }], reason: "불량" });
  assert.equal(ret.taxInvoice.supplyTotal, -1800, "2 × 1000 × 0.9 음수");

  // 영업 대시보드 매출 = 출고 − 반품(할인 반영)
  const dash = await erp("sales-dashboard?year=2032");
  assert.equal(dash.monthlyTrend.months[2].revenue, 9000 + 20000 - 1800);

  // 견적서 복사 — 새 임시 저장 문서, 이력은 복사하지 않는다.
  await erp("quotations/nope/copy", {}, 404);
  await erp(`quotations/${q.id}/copy`, { date: "2032-13-01" }, 400);
  const copy = (await erp(`quotations/${q.id}/copy`, { date: "2032-05-01" })).quotation;
  assert.notEqual(copy.id, q.id);
  assert.equal(copy.status, "draft");
  assert.equal(copy.quoteNo, null);
  assert.equal(copy.date, "2032-05-01");
  assert.equal(copy.validUntil, "2032-05-11", "원본과 같은 10일 유효기간");
  assert.equal(copy.partnerName, "할인 고객");
  assert.equal(copy.memo, "원본 메모");
  assert.equal(copy.copiedFromId, q.id);
  assert.equal(copy.copiedFromNo, q.quoteNo || "");
  assert.equal(copy.lines.length, 2);
  assert.equal(copy.lines[0].discountRate, 10);
  assert.equal(copy.supplyTotal, 29000);
  assert.equal(copy.fulfillments, undefined);
  assert.equal(copy.returns, undefined);
  // 복사본도 정상 흐름을 탄다(발송 가능).
  const sent = await erp(`quotations/${copy.id}/send`, {});
  assert.equal(sent.quotation.status, "sent");
  // 날짜를 생략하면 오늘(한국) 날짜
  const today = (await erp(`quotations/${q.id}/copy`, {})).quotation;
  assert.match(today.date, /^\d{4}-\d{2}-\d{2}$/);
  const listed = (await erp("quotations")).quotations;
  assert.ok(listed.find(x => x.id === copy.id));
};
