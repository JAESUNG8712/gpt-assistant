"use strict";
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");

// 부분 출고·입고와 반품을 JSON/PostgreSQL 양쪽에서 같은 계약으로 검증한다.
module.exports = async function checkPartialFulfillment(baseUrl, token, tag = "pf") {
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
  const invoices = async () => (await call("/api/accounting/tax-invoices")).taxInvoices;
  const stockOf = async (itemId, locationId) => ((await erp("stock")).stock.find(r => r.itemId === itemId && r.locationId === locationId)?.qty) ?? 0;

  const itemA = (await erp("items", { code: `${tag}-A`, name: "품목A", unit: "EA" })).item.id;
  const itemB = (await erp("items", { code: `${tag}-B`, name: "품목B", unit: "EA" })).item.id;
  const loc = (await erp("locations", { name: `${tag}-창고` })).location.id;
  await erp("stock/adjust", { itemId: itemA, locationId: loc, type: "in", qty: 100 });
  await erp("stock/adjust", { itemId: itemB, locationId: loc, type: "in", qty: 100 });

  // ── 견적서: 부분 출고 ────────────────────────────────────────────────
  const q = (await erp("quotations", {
    date: "2032-03-10", partnerName: "부분출고 고객", locationId: loc,
    items: [{ itemId: itemA, qty: 10, unitPrice: 1000 }, { itemId: itemB, qty: 4, unitPrice: 5000 }],
  })).quotation;
  const qPath = "quotations/" + q.id;
  await erp(qPath + "/send", {});
  await erp(qPath + "/accept", {});

  // 잘못된 요청은 아무 부수효과 없이 거부된다.
  await erp(qPath + "/ship", { lines: [{ index: 0, qty: 11 }] }, 400);
  await erp(qPath + "/ship", { lines: [{ index: 9, qty: 1 }] }, 400);
  await erp(qPath + "/ship", { lines: [{ index: 0, qty: 0 }] }, 400);
  await erp(qPath + "/ship", { lines: [{ index: 0, qty: 1 }, { index: 0, qty: 1 }] }, 400);
  await erp(qPath + "/ship", { lines: [] }, 400);
  await erp(qPath + "/ship", { lines: [{ index: 0, qty: 1 }], date: "2032-13-40" }, 400);
  assert.equal(await stockOf(itemA, loc), 100, "거부된 출고는 재고를 바꾸지 않는다");

  const round1 = await erp(qPath + "/ship", { lines: [{ index: 0, qty: 4 }], date: "2032-03-12" });
  assert.equal(round1.quotation.status, "partially_shipped");
  assert.equal(round1.quotation.fulfillments.length, 1);
  assert.equal(round1.taxInvoice.invoiceNo.startsWith("TI-2032-"), true);
  assert.equal(await stockOf(itemA, loc), 96);
  assert.equal(await stockOf(itemB, loc), 100);
  const inv1 = (await invoices()).find(t => t.id === round1.quotation.fulfillments[0].taxInvoiceId);
  assert.equal(inv1.supplyTotal, 4000);
  assert.equal(inv1.taxTotal, 400);
  assert.equal(inv1.issueDate, "2032-03-12");
  assert.equal(inv1.direction, "sales");

  // 부분 출고된 문서는 계속 출고할 수 있지만 잔여 수량을 넘을 수 없다.
  await erp(qPath + "/ship", { lines: [{ index: 0, qty: 7 }] }, 400);
  const round2 = await erp(qPath + "/ship", { lines: [{ index: 0, qty: 6 }, { index: 1, qty: 1 }] });
  assert.equal(round2.quotation.status, "partially_shipped");
  assert.equal(round2.quotation.fulfillments[1].round, 2);
  assert.notEqual(round2.taxInvoice.invoiceNo, round1.taxInvoice.invoiceNo, "회차마다 세금계산서가 따로 발행된다");

  // 본문 생략 = 잔여 전부 → 완료
  const round3 = await erp(qPath + "/ship", {});
  assert.equal(round3.quotation.status, "shipped");
  assert.equal(round3.quotation.fulfillments.length, 3);
  const inv3 = (await invoices()).find(t => t.id === round3.quotation.fulfillments[2].taxInvoiceId);
  assert.equal(inv3.supplyTotal, 15000, "잔여 3×5000");
  assert.equal(await stockOf(itemA, loc), 90);
  assert.equal(await stockOf(itemB, loc), 96);
  await erp(qPath + "/ship", {}, 400); // 이미 전량 출고

  // ── 견적서: 반품(수정세금계산서) ─────────────────────────────────────
  await erp(qPath + "/return", { round: 1, lines: [{ index: 0, qty: 1 }] }, 400); // 사유 없음
  await erp(qPath + "/return", { round: 9, lines: [{ index: 0, qty: 1 }], reason: "오류" }, 400);
  await erp(qPath + "/return", { round: 1, lines: [{ index: 1, qty: 1 }], reason: "1차에 없던 품목" }, 400);
  await erp(qPath + "/return", { round: 1, lines: [{ index: 0, qty: 5 }], reason: "초과" }, 400);
  const ret1 = await erp(qPath + "/return", { round: 1, lines: [{ index: 0, qty: 3 }], reason: "불량", date: "2032-04-01" });
  assert.equal(ret1.quotation.returns.length, 1);
  assert.equal(ret1.quotation.status, "shipped", "반품해도 문서 상태는 유지된다");
  assert.equal(await stockOf(itemA, loc), 93, "반품 입고로 재고 복구");
  const amend = (await invoices()).find(t => t.id === ret1.taxInvoice.id);
  assert.equal(amend.invoiceKind, "amendment");
  assert.equal(amend.amendsInvoiceId, inv1.id);
  assert.equal(amend.supplyTotal, -3000);
  assert.equal(amend.taxTotal, -300);
  assert.equal(amend.grandTotal, -3300);
  assert.equal(amend.direction, "sales");
  await erp(qPath + "/return", { round: 1, lines: [{ index: 0, qty: 2 }], reason: "잔여 반품 가능 1개 초과" }, 400);
  await erp(qPath + "/return", { round: 1, lines: [{ index: 0, qty: 1 }], reason: "나머지", date: "2032-04-02" });

  // 반품 수정세금계산서는 취소할 수 없다.
  const voidAmend = await call(`/api/accounting/tax-invoices/${amend.id}/void`, { reason: "시도" }, 400);
  assert.match(voidAmend.message, /수정세금계산서/);

  // 원본 세금계산서가 취소되면 그 회차는 수정세금계산서를 발행할 수 없다.
  await call(`/api/accounting/tax-invoices/${round2.quotation.fulfillments[1].taxInvoiceId}/void`, { reason: "원본 오류" });
  const afterVoid = await erp(qPath + "/return", { round: 2, lines: [{ index: 1, qty: 1 }], reason: "원본 취소 후" }, 409);
  assert.equal(afterVoid.code, "ERP_ORIGINAL_INVOICE_VOID");

  // 부가세 신고자료는 수정세금계산서(음수)를 그대로 합산한다: 4000+15000+(2차 취소분 제외)-4000(반품 3+1)
  const vat = await call("/api/accounting/vat-report?from=2032-03-01&to=2032-04-30");
  assert.equal(vat.sales.supplyTotal, 4000 + 15000 - 3000 - 1000);

  // 대시보드 순매출 = 출고 - 반품 (예전 방식이면 전액이 잡힌다)
  const dash = await erp("sales-dashboard?year=2032");
  const mar = dash.monthlyTrend.months[2];
  assert.equal(mar.revenue, 4000 + 6000 + 5000 + 15000 - 4000, "출고 4000+(6000+5000)+15000 - 반품 4000");

  // ── 레거시(회차 기록 없는) 출고 완료 문서도 반품할 수 있다 ───────────────
  // 새 문서를 만들어 한 번에 전량 출고 → 회차 1개짜리 문서와 동일하게 동작
  const q2 = (await erp("quotations", { date: "2032-05-01", partnerName: "전량 출고", locationId: loc, items: [{ itemId: itemA, qty: 2, unitPrice: 700 }] })).quotation;
  await erp(`quotations/${q2.id}/send`, {}); await erp(`quotations/${q2.id}/accept`, {});
  const full = await erp(`quotations/${q2.id}/ship`, {});
  assert.equal(full.quotation.status, "shipped");
  assert.equal(full.quotation.fulfillments.length, 1);

  // ── 발주서: 부분 입고 + 반품(재고 부족 검사) ─────────────────────────
  const po = (await erp("purchase-orders", { date: "2032-06-01", partnerName: "공급사", locationId: loc, items: [{ itemId: itemB, qty: 10, unitPrice: 300 }] })).purchaseOrder;
  const poPath = "purchase-orders/" + po.id;
  await erp(poPath + "/receive", {}, 400); // 아직 발주 확정 전
  await erp(poPath + "/confirm", {});
  await erp(poPath + "/receive", { lines: [{ index: 0, qty: 11 }] }, 400);
  const r1 = await erp(poPath + "/receive", { lines: [{ index: 0, qty: 6 }] });
  assert.equal(r1.purchaseOrder.status, "partially_received");
  assert.equal(await stockOf(itemB, loc), 102);
  await erp(poPath + "/cancel", { reason: "부분 입고 후 취소 불가" }, 400);
  const pInv1 = (await invoices()).find(t => t.id === r1.purchaseOrder.fulfillments[0].taxInvoiceId);
  assert.equal(pInv1.direction, "purchase");
  assert.equal(pInv1.supplyTotal, 1800);
  const r2 = await erp(poPath + "/receive", {});
  assert.equal(r2.purchaseOrder.status, "received");
  assert.equal(await stockOf(itemB, loc), 106);
  // 입고 반품은 재고를 차감하고 음수 매입 수정세금계산서를 발행한다.
  const pret = await erp(poPath + "/return", { round: 1, lines: [{ index: 0, qty: 2 }], reason: "규격 불일치" });
  assert.equal(await stockOf(itemB, loc), 104);
  const pAmend = (await invoices()).find(t => t.id === pret.taxInvoice.id);
  assert.equal(pAmend.direction, "purchase");
  assert.equal(pAmend.supplyTotal, -600);
  assert.equal(pAmend.amendsInvoiceId, pInv1.id);
  // 재고보다 많이 반품(차감)할 수는 없다.
  await erp("stock/adjust", { itemId: itemB, locationId: loc, type: "out", qty: 103 });
  await erp(poPath + "/return", { round: 1, lines: [{ index: 0, qty: 3 }], reason: "재고 부족 시도" }, 400);
  assert.equal(await stockOf(itemB, loc), 1);

  return { itemA, itemB, loc };
};
