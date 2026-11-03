const { test, expect } = require("@playwright/test");

test("급여 조정은 실제 저장되고 동료의 급여 확정 뒤 추가한 금액은 되돌린다", async ({ page }) => {
  await page.goto("/");
  await page.fill("#l-id", "e2e_admin");
  await page.fill("#l-pw", "E2eTestPw123");
  // Explicitly await the real save below instead of racing the debounce timer.
  await page.evaluate(() => { autoSaveDebounced = () => {}; connectSSE = async () => {}; });
  await page.click(".login-card button.btn-primary");
  await expect(page.locator("#main")).toBeVisible();
  await page.evaluate(() => {
    _payMgmtState = { year: 2096, month: 12, dept: "", team: "", search: "" };
    openPayAdjustModal(currentUser.id);
  });
  await page.fill("#pay-adj-amount", "12345");
  await page.fill("#pay-adj-note", "실제 저장 검증");
  await page.locator('[onclick^="addPayAdjustment("]').click();
  const saved = await page.evaluate(async () => {
    const result = await saveToServer(true);
    const d = await serverRequest("GET", "/data");
    return { status: result.status, row: d.data.payrollAdjustments.find(a => a.note === "실제 저장 검증") };
  });
  expect(["saved", "merged"]).toContain(saved.status);
  expect(saved.row.amount).toBe(12345);

  // Another browser confirms the payslip while this edit screen is still open.
  await page.evaluate(async () => {
    const d = await serverRequest("GET", "/data");
    const r = await serverRequest("POST", "/save", { _version: d.version,
      payslips: [{ id: "e2e-payroll-confirmed", empId: currentUser.id, year: 2096, month: 12,
        confirmed: true, gross: 20000, netPay: 18000 }] });
    if (!r.ok || r.partial) throw new Error(JSON.stringify(r));
  });
  await page.fill("#pay-adj-amount", "54321");
  await page.fill("#pay-adj-note", "확정 이후 차단");
  await page.locator('[onclick^="addPayAdjustment("]').click();
  const rejected = await page.evaluate(async () => {
    const result = await saveToServer(true);
    const d = await serverRequest("GET", "/data");
    return { status: result.status, rows: d.data.payrollAdjustments,
      localRows: payrollAdjustments, reasons: result.response?.warnings?.rejectedRecords };
  });
  expect(rejected.status).toBe("partial");
  expect(rejected.reasons.some(r => r.field === "payrollAdjustments" && r.reason === "CONFIRMED")).toBe(true);
  expect(rejected.rows.some(a => a.note === "확정 이후 차단")).toBe(false);
  expect(rejected.localRows.some(a => a.note === "확정 이후 차단")).toBe(false);
  expect(rejected.rows.find(a => a.id === saved.row.id).amount).toBe(12345);
  await page.evaluate(async () => {
    const d = await serverRequest("GET", "/data");
    payslips = d.data.payslips;
    openPayAdjustModal(currentUser.id);
  });
  await expect(page.locator('[onclick^="addPayAdjustment("]')).toBeDisabled();
  await expect(page.getByText("급여명세서가 확정되어 조정 항목을 추가하거나 삭제할 수 없습니다.", { exact: true })).toBeVisible();
});
