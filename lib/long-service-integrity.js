"use strict";

// A long-service payout is represented in three independently persisted parts:
// the payroll adjustment, the employee history entry and (when it already
// exists) the month's payslip.  /save is intentionally partial for unrelated
// records, but accepting only one of these linked changes creates a false HR or
// payroll record.  Capture the user's linked intent before permission/module
// filters run, then assert it against the transaction's final state.

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (key === "_rev" || key === "updatedAt" || key === "createdAt") continue;
    out[key] = stable(value[key]);
  }
  return out;
}

function same(a, b) {
  return JSON.stringify(stable(a)) === JSON.stringify(stable(b));
}

function adjustmentKey(row) {
  if (!row || row.source !== "longservice_award") return null;
  if (row.sourceKey) return String(row.sourceKey);
  const years = Number(row.longServiceYears);
  return row.empId != null && Number.isInteger(years)
    ? `longservice-${row.empId}-${years}` : null;
}

function historyKey(employee, entry) {
  if (!employee || !entry || entry.type !== "longservice") return null;
  const years = Number(entry.year ?? entry.longServiceYears);
  return employee.id != null && Number.isInteger(years)
    ? `longservice-${employee.id}-${years}` : null;
}

function indexAdjustments(state) {
  const map = new Map();
  for (const row of state?.payrollAdjustments || []) {
    const key = adjustmentKey(row);
    if (key) map.set(key, row);
  }
  return map;
}

function indexHistories(state) {
  const map = new Map();
  for (const employee of state?.employees || []) {
    for (const entry of employee?.hrHistory || []) {
      const key = historyKey(employee, entry);
      if (key) map.set(key, { employeeId: String(employee.id), entry });
    }
  }
  return map;
}

function payslipKey(row) {
  return row && row.empId != null && row.year != null && row.month != null
    ? `${row.empId}\u0000${Number(row.year)}\u0000${Number(row.month)}` : null;
}

function indexPayslips(state) {
  const map = new Map();
  for (const row of state?.payslips || []) {
    const key = payslipKey(row);
    if (key) map.set(key, row);
  }
  return map;
}

function tombstonesFor(state, field) {
  const rows = state?.recordTombstones?.[field];
  return Array.isArray(rows) ? rows : [];
}

function projectCollection(beforeRows, requested, field, keyFn) {
  const byId = new Map();
  for (const row of beforeRows || []) {
    if (row?.id != null) byId.set(String(row.id), row);
  }
  if (Array.isArray(requested?.[field])) {
    for (const row of requested[field]) {
      if (row?.id != null) byId.set(String(row.id), row);
    }
  }
  for (const tombstone of tombstonesFor(requested, field)) {
    if (tombstone?.id != null) byId.delete(String(tombstone.id));
  }
  const desired = new Map();
  for (const row of byId.values()) {
    const key = keyFn(row);
    if (key) desired.set(key, row);
  }
  return desired;
}

function projectHistories(before, requested) {
  const desired = indexHistories(before);
  if (!Array.isArray(requested?.employees)) return desired;
  for (const employee of requested.employees) {
    if (!employee || !Array.isArray(employee.hrHistory)) continue;
    const employeeId = String(employee.id);
    for (const [key, value] of desired) {
      if (value.employeeId === employeeId) desired.delete(key);
    }
    for (const entry of employee.hrHistory) {
      const key = historyKey(employee, entry);
      if (key) desired.set(key, { employeeId, entry });
    }
  }
  return desired;
}

function createLongServiceBundleIntent(before, requested) {
  const beforeAdjustments = indexAdjustments(before);
  const requestedAdjustments = projectCollection(
    before?.payrollAdjustments, requested, "payrollAdjustments", adjustmentKey
  );
  const beforeHistories = indexHistories(before);
  const requestedHistories = projectHistories(before, requested);
  const beforePayslips = indexPayslips(before);
  const requestedPayslips = projectCollection(
    before?.payslips, requested, "payslips", payslipKey
  );
  const keys = new Set([
    ...beforeAdjustments.keys(), ...requestedAdjustments.keys(),
    ...beforeHistories.keys(), ...requestedHistories.keys(),
  ]);
  const bundles = [];

  for (const key of keys) {
    const adjustmentChanged = !same(beforeAdjustments.get(key), requestedAdjustments.get(key));
    const historyChanged = !same(beforeHistories.get(key), requestedHistories.get(key));
    // Preserve /save's existing partial semantics for an isolated payroll edit.
    // The atomic guard applies only when the client explicitly changed both
    // halves of the long-service workflow (the actual apply/cancel UI contract).
    if (!adjustmentChanged || !historyChanged) continue;
    const relation = requestedAdjustments.get(key) || beforeAdjustments.get(key);
    const periodKey = payslipKey(relation);
    const payslipChanged = !!periodKey &&
      !same(beforePayslips.get(periodKey), requestedPayslips.get(periodKey));
    bundles.push({
      key,
      adjustment: requestedAdjustments.get(key),
      history: requestedHistories.get(key),
      periodKey,
      payslipChanged,
      payslip: periodKey ? requestedPayslips.get(periodKey) : undefined,
    });
  }
  return bundles.length ? bundles : null;
}

function assertLongServiceBundleIntegrity(intent, after) {
  if (!intent) return;
  const adjustments = indexAdjustments(after);
  const histories = indexHistories(after);
  const payslips = indexPayslips(after);
  for (const bundle of intent) {
    const consistent = same(adjustments.get(bundle.key), bundle.adjustment) &&
      same(histories.get(bundle.key), bundle.history) &&
      (!bundle.payslipChanged || same(payslips.get(bundle.periodKey), bundle.payslip));
    if (consistent) continue;
    const error = new Error("장기근속 포상과 급여·인사이력을 함께 저장하지 못했습니다. 최신 상태를 다시 확인하세요.");
    error.status = 409;
    error.code = "LONG_SERVICE_BUNDLE_CONFLICT";
    error.details = { sourceKey: bundle.key };
    throw error;
  }
}

module.exports = { createLongServiceBundleIntent, assertLongServiceBundleIntegrity };
