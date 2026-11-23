const { test, expect } = require("@playwright/test");

// 재고평가 모달 — 창고별 보기와 재고자산 평가 조정 전표 발행.
async function loginAsAdmin(page) {
  await page.goto("/");
  await page.fill("#l-id", "e2e_admin");
  await page.fill("#l-pw", "E2eTestPw123");
  await page.evaluate(() => { autoSaveDebounced = () => {}; loadFromServer = async () => {}; connectSSE = async () => {}; });
  await page.click(".login-card button.btn-primary");
  await expect(page.locator("#main")).toBeVisible({ timeout: 10000 });
}

test("재고평가: 창고별 보기로 전환하고 평가 조정 전표를 발행한다", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await loginAsAdmin(page);
  const tag = `lv${Date.now()}`;
  const ids = await page.evaluate(async (tag) => {
    const item = (await serverRequest("POST", "/api/erp/items", { code: tag, name: `창고평가${tag}`, unit: "EA", unitCost: 500 })).item;
    const l1 = (await serverRequest("POST", "/api/erp/locations", { name: `${tag}본사` })).location;
    const l2 = (await serverRequest("POST", "/api/erp/locations", { name: `${tag}지점` })).location;
    const inv = (await serverRequest("POST", "/api/accounting/accounts", { code: `${tag}I`, name: `재고자산${tag}`, type: "asset", user: "t" })).account;
    const adj = (await serverRequest("POST", "/api/accounting/accounts", { code: `${tag}A`, name: `평가손익${tag}`, type: "expense", user: "t" })).account;
    await serverRequest("POST", "/api/erp/stock/adjust", { itemId: item.id, locationId: l1.id, type: "in", qty: 10, unitCost: 100 });
    await serverRequest("POST", "/api/erp/stock/adjust", { itemId: item.id, locationId: l1.id, type: "in", qty: 10, unitCost: 200 });
    await serverRequest("POST", "/api/erp/stock/transfer", { itemId: item.id, fromLocationId: l1.id, toLocationId: l2.id, qty: 12 });
    return { inv: inv.id, adj: adj.id };
  }, tag);

  await page.evaluate(() => gotoPage("inv-stock"));
  await page.getByRole("button", { name: "💰 재고평가" }).click();
  const modal = page.locator(".modal-ov");
  await modal.locator("#val-view").selectOption("location");
  await modal.getByRole("button", { name: "조회" }).click();
  const headBase = modal.locator("tbody tr", { hasText: `📍 ${tag}본사` });
  const headBranch = modal.locator("tbody tr", { hasText: `📍 ${tag}지점` });
  await expect(headBase).toBeVisible();
  await expect(headBase).toContainText("1,200");   // 이동평균
  await expect(headBase).toContainText("1,600");   // FIFO
  await expect(headBranch).toContainText("1,800");
  await expect(headBranch).toContainText("1,400");

  // 회계 반영 — 계정을 고르지 않으면 막히고, 고르면 전표가 발행된다.
  await modal.getByRole("button", { name: "전표 발행" }).click();
  await expect(page.locator(".toast").last()).toContainText("계정을 선택");
  await modal.locator("#val-post-inv").selectOption(ids.inv);
  await modal.locator("#val-post-adj").selectOption(ids.adj);
  await modal.getByRole("button", { name: "전표 발행" }).click();
  await page.getByRole("button", { name: "발행", exact: true }).click();
  await expect(page.locator(".toast").last()).toContainText("발행 —");
  const posted = await page.evaluate(async () => (await serverRequest("GET", "/api/accounting/vouchers")).vouchers.filter(v => v.source === "stock_valuation").length);
  expect(posted).toBe(1);
  expect(pageErrors).toEqual([]);
});
