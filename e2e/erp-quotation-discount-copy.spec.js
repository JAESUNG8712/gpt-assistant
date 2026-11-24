const { test, expect } = require("./fixtures");

// 견적서 품목별 할인율 입력·합계 계산과 복사 버튼.
async function loginAsAdmin(page) {
  await page.goto("/");
  await page.fill("#l-id", "e2e_admin");
  await page.fill("#l-pw", "E2eTestPw123");
  await page.evaluate(() => {
    autoSaveDebounced = () => {};
    loadFromServer = async () => {};
    connectSSE = async () => {};
  });
  await page.click(".login-card button.btn-primary");
  await expect(page.locator("#main")).toBeVisible({ timeout: 10000 });
}

test("견적서: 할인율이 합계에 반영되고 복사하면 같은 할인율의 새 임시 견적서가 생긴다", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await loginAsAdmin(page);
  const partner = `할인고객${Date.now()}`;

  await page.evaluate(async () => { await loadErpFromServer(); gotoPage("sales-quotations"); });
  await page.evaluate(() => openQuotationModal());
  await page.fill("#qt-date", "2032-03-10");
  await page.fill("#qt-partner", partner);
  await page.locator("#qt-items input[placeholder='품목명']").first().fill("할인품목");
  await page.locator("#qt-items input[placeholder='수량']").first().fill("10");
  await page.locator("#qt-items input[placeholder='단가']").first().fill("1000");
  await page.locator("#qt-items input[placeholder='할인%']").first().fill("10");
  // 10 × 1000 × 0.9 = 9,000 / 세액 900 / 합계 9,900
  await expect(page.locator("#qt-totals")).toContainText("공급가액: 9,000");
  await expect(page.locator("#qt-totals")).toContainText("합계: 9,900");
  await page.locator(".modal-ov").getByRole("button", { name: "저장" }).click();

  const row = page.locator("#sales-quotations-tbl tbody tr", { hasText: partner });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("9,900");
  await row.getByRole("button", { name: "복사" }).click();
  await expect(page.locator("#sales-quotations-tbl tbody tr", { hasText: partner })).toHaveCount(2);

  const copy = await page.evaluate((partner) => erpQuotations.filter(q => q.partnerName === partner).find(q => q.copiedFromId), partner);
  expect(copy.status).toBe("draft");
  expect(copy.lines[0].discountRate).toBe(10);
  expect(copy.grandTotal).toBe(9900);
  expect(pageErrors).toEqual([]);
});
