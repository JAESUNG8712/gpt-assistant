const { test, expect } = require("@playwright/test");

// 재고평가 모달 — 발주 입고 단가와 수동 취득단가로 이동평균/FIFO 금액이 서로 다르게 표시된다.
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

test("재고평가: 이동평균과 FIFO가 다른 금액을 보여주고 취득단가 입력이 반영된다", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await loginAsAdmin(page);
  const tag = `val${Date.now()}`;

  await page.evaluate(async (tag) => {
    const item = (await serverRequest("POST", "/api/erp/items", { code: tag, name: `평가품목${tag}`, unit: "EA", unitCost: 500 })).item;
    const loc = (await serverRequest("POST", "/api/erp/locations", { name: `${tag}창고` })).location;
    window.__val = { item: item.id, loc: loc.id };
    // 입고 10개 @100, 입고 10개 @200, 출고 15개 → 이동평균 750 / FIFO 1000
    await serverRequest("POST", "/api/erp/stock/adjust", { itemId: item.id, locationId: loc.id, type: "in", qty: 10, unitCost: 100 });
    await serverRequest("POST", "/api/erp/stock/adjust", { itemId: item.id, locationId: loc.id, type: "in", qty: 10, unitCost: 200 });
    await serverRequest("POST", "/api/erp/stock/adjust", { itemId: item.id, locationId: loc.id, type: "out", qty: 15 });
  }, tag);

  await page.evaluate(() => gotoPage("inv-stock"));
  await expect(page.locator("#content")).toContainText("재고 현황");
  await page.getByRole("button", { name: "💰 재고평가" }).click();
  const row = page.locator(".modal-ov tbody tr", { hasText: `평가품목${tag}` });
  await expect(row).toBeVisible();
  const cells = await row.locator("td").allInnerTexts();
  expect(cells[2]).toContain("5");
  expect(cells[3].trim()).toBe("150");
  expect(cells[4].trim()).toBe("750");
  expect(cells[5].trim()).toBe("200");
  expect(cells[6].trim()).toBe("1,000");

  // 재고 조정 모달에는 입고 취득단가 입력란이 있다.
  await page.locator(".modal-ov").getByRole("button", { name: "닫기" }).click();
  await page.evaluate(async () => { await loadErpFromServer(); openStockAdjustModal(); });
  await expect(page.locator("#adj-unit-cost")).toBeVisible();
  expect(pageErrors).toEqual([]);
});
