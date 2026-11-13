"use strict";
const assert = require("node:assert/strict");

// Exercise the same quotation and inventory contract in JSON and PostgreSQL.
module.exports = async function checkShipmentStock(api, token) {
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  async function request(path, body, expected = 200) {
    const res = await api("/api/erp/" + path, {
      headers, method: body === undefined ? "GET" : "POST", body: JSON.stringify(body),
    });
    const json = await res.json();
    assert.equal(res.status, expected, JSON.stringify(json));
    return json;
  }
  const itemId = "ship::sample", locationId = "warehouse";
  const otherItem = "ship", otherLocation = "sample::warehouse";
  for (const id of [itemId, otherItem]) await request("items", { id, code: id, name: id });
  for (const id of [locationId, otherLocation]) await request("locations", { id, name: id });
  await request("stock/adjust", { itemId, locationId, type: "in", qty: 5 });
  await request("stock/adjust", { itemId: otherItem, locationId: otherLocation, type: "in", qty: 12 });
  const { quotation } = await request("quotations", {
    date: "2032-01-22", partnerName: "Sample", locationId,
    items: [100, 200].map(unitPrice => ({ itemId, qty: 3, unitPrice })),
  });
  const path = "quotations/" + quotation.id;
  await request(path + "/send", {});
  await request(path + "/accept", {});
  await request(path + "/ship", {}, 400);
  const afterFailure = (await request("quotations")).quotations.find(q => q.id === quotation.id);
  assert.equal(afterFailure.status, "accepted");
  assert.ok(!afterFailure.taxInvoiceId);
  const stock = (await request("stock")).stock;
  assert.equal(stock.find(row => row.itemId === itemId && row.locationId === locationId)?.qty, 5);
  assert.equal(stock.find(row => row.itemId === otherItem && row.locationId === otherLocation)?.qty, 12);
  await request("stock/adjust", { itemId, locationId, type: "in", qty: 1 });
  const shipped = await request(path + "/ship", {});
  assert.equal(shipped.quotation.status, "shipped");
  assert.deepEqual(shipped.quotation.lines.map(l => l.unitPrice), [100, 200]);
  const ledger = (await request("stock/ledger")).ledger.filter(l => l.refId === quotation.id);
  assert.equal(ledger.length, 2);
  assert.equal(new Set(ledger.map(l => l.id)).size, 2);
  assert.ok(ledger.every(l => l.id && l.type === "out" && l.qty === 3));
  assert.equal((await request("stock")).stock.find(row => row.itemId === itemId && row.locationId === locationId)?.qty, 0);
};
