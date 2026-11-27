"use strict";

// Pure inspection: never repair, deduplicate, or mutate the supplied snapshot.
const COLLECTIONS = Object.freeze(["items", "locations", "quotations", "purchaseOrders", "purchaseRequests", "stockLedger"]);
function auditError(code) { return Object.assign(new Error(code), { code }); }
function key(value) {
  return typeof value === "string" && value.trim() ? value :
    typeof value === "number" && Number.isFinite(value) ? String(value) : null;
}
function number(value) {
  return (typeof value === "number" || typeof value === "string" && value.trim() !== "") && Number.isFinite(Number(value)) ? Number(value) : null;
}
function inspectErp(snapshot, { maxRows = 50000, sampleLimit = 10 } = {}) {
  if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 50000 ||
      !Number.isSafeInteger(sampleLimit) || sampleLimit < 0 || sampleLimit > 50) throw auditError("INVALID_LIMIT");
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) throw auditError("INVALID_SNAPSHOT");
  if (snapshot.masterTombstones != null && (typeof snapshot.masterTombstones !== "object" || Array.isArray(snapshot.masterTombstones))) throw auditError("INVALID_TOMBSTONES");
  const counts = {}, maps = {}, issues = new Map();
  let totalRows = 0, invalidStock = 0;
  function finding(code, collection, index) {
    let issue = issues.get(code);
    if (!issue) issues.set(code, issue = { code, count: 0, samples: [] });
    issue.count++;
    // Ordinals locate the source without exposing employee names, notes, prices,
    // user-controlled identifiers, or connection strings in the report.
    if (issue.samples.length < sampleLimit) issue.samples.push({ collection, row: index + 1 });
  }
  for (const collection of COLLECTIONS) {
    const rows = snapshot[collection];
    if (!Array.isArray(rows)) throw auditError("INCOMPLETE_SNAPSHOT");
    counts[collection] = rows.length;
    totalRows += rows.length;
    if (totalRows > maxRows) throw auditError("ROW_LIMIT_EXCEEDED");
    const map = maps[collection] = new Map();
    rows.forEach((row, index) => {
      if (!row || typeof row !== "object" || Array.isArray(row) || !key(row.id)) {
        finding("INVALID_RECORD_ID", collection, index); return;
      }
      const id = key(row.id);
      if (row._columnMismatch === true) finding("COLUMN_DATA_MISMATCH", collection, index);
      if (map.has(id)) finding("DUPLICATE_RECORD_ID", collection, index);
      else map.set(id, row);
    });
  }
  function ref(value, target, collection, index, required = true) {
    const id = key(value);
    if (!id) { if (required) finding("MISSING_REFERENCE", collection, index); return; }
    const row = maps[target].get(id);
    if (!row) finding("ORPHAN_REFERENCE", collection, index);
    else if (row._deleted === true) finding("DELETED_MASTER_REFERENCE", collection, index);
  }
  const codes = new Set();
  snapshot.items.forEach((row, index) => {
    if (!row || typeof row !== "object" || row._deleted === true || row.active === false) return;
    const code = typeof row.code === "string" ? row.code.trim() : "";
    if (!code) finding("MISSING_ITEM_CODE", "items", index);
    else if (codes.has(code)) finding("DUPLICATE_ACTIVE_ITEM_CODE", "items", index);
    else codes.add(code);
  });
  for (const collection of ["items", "locations"]) {
    const deleted = snapshot.masterTombstones?.[collection];
    if (deleted !== undefined && !Array.isArray(deleted)) throw auditError("INVALID_TOMBSTONES");
    const ids = new Set((deleted || []).map(key));
    snapshot[collection].forEach((row, index) => {
      if (row && row._deleted !== true && ids.has(key(row.id))) finding("LIVE_TOMBSTONE", collection, index);
    });
  }
  for (const collection of ["quotations", "purchaseOrders", "purchaseRequests"]) {
    snapshot[collection].forEach((doc, index) => {
      if (!doc || typeof doc !== "object") return;
      if (!Array.isArray(doc.lines) || !doc.lines.length) { finding("INVALID_DOCUMENT_LINES", collection, index); return; }
      const quote = collection === "quotations";
      const inventoryPosted = ["shipped", "partially_shipped"].includes(doc.status);
      if (collection !== "purchaseRequests") ref(doc.locationId, "locations", collection, index, !quote || inventoryPosted);
      for (const line of doc.lines) {
        if (!line || typeof line !== "object") { finding("INVALID_DOCUMENT_LINES", collection, index); continue; }
        // Free-text quotation lines are valid until inventory is actually posted.
        ref(line.itemId, "items", collection, index, !quote || inventoryPosted);
        if (number(line.qty) === null || number(line.qty) <= 0 || number(line.unitPrice) === null || number(line.unitPrice) < 0) {
          finding("INVALID_DOCUMENT_AMOUNT", collection, index);
        }
      }
      if (collection === "purchaseRequests" && doc.status === "converted") {
        const po = maps.purchaseOrders.get(key(doc.convertedPoId));
        if (!po || key(po.sourcePurchaseRequestId) !== key(doc.id)) finding("BROKEN_PURCHASE_LINK", collection, index);
      }
      if (collection === "purchaseOrders" && key(doc.sourcePurchaseRequestId)) {
        const pr = maps.purchaseRequests.get(key(doc.sourcePurchaseRequestId));
        if (!pr || pr.status !== "converted" || key(pr.convertedPoId) !== key(doc.id)) finding("BROKEN_PURCHASE_LINK", collection, index);
      }
    });
  }
  const balances = new Map();
  snapshot.stockLedger.forEach((row, index) => {
    if (!row || typeof row !== "object") { invalidStock++; return; }
    ref(row.itemId, "items", "stockLedger", index);
    ref(row.locationId, "locations", "stockLedger", index);
    const qty = number(row.qty);
    if (!["in", "out"].includes(row.type) || qty === null || qty <= 0 || !key(row.itemId) || !key(row.locationId)) {
      finding("INVALID_STOCK_ENTRY", "stockLedger", index); invalidStock++; return;
    }
    const pair = JSON.stringify([key(row.itemId), key(row.locationId)]);
    const balance = balances.get(pair) || { qty: 0, index };
    balance.qty += row.type === "out" ? -qty : qty;
    balances.set(pair, balance);
    if (["quotation", "quotation_return"].includes(row.refType)) ref(row.refId, "quotations", "stockLedger", index);
    if (["po", "po_return"].includes(row.refType)) ref(row.refId, "purchaseOrders", "stockLedger", index);
  });
  for (const balance of balances.values()) {
    if (!Number.isFinite(balance.qty)) { finding("INVALID_STOCK_TOTAL", "stockLedger", balance.index); invalidStock++; }
    else if (balance.qty < -1e-9) finding("NEGATIVE_STOCK_BALANCE", "stockLedger", balance.index);
  }
  const result = [...issues.values()].sort((a, b) => a.code.localeCompare(b.code)).map(issue => ({ ...issue, omitted: issue.count - issue.samples.length }));
  return { version: 1, complete: true, counts, totalRows, balanceChecksComplete: invalidStock === 0,
    totalFindings: result.reduce((sum, issue) => sum + issue.count, 0), issues: result };
}
module.exports = { inspectErp, COLLECTIONS, auditError };
