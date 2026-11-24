const { test, expect } = require("./fixtures");

// ERP 부분 출고·입고 + 반품 — 화면 흐름(회차 모달, 잔여 수량 검증, 반품 가능 수량, 상태 배지).
// ERP 문서는 전용 REST 테이블이라 /save 전체상태 블롭과 무관하므로 loadFromServer를
// 로그인 전에 막아도 안전하다.
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
const toast = page => page.locator(".toast").last();

test("견적서를 두 번에 나눠 출고하고 한 회차를 반품하면 상태·재고·세금계산서가 맞는다", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", e => pageErrors.push(e.message));
  await loginAsAdmin(page);

  const seed = await page.evaluate(async () => {
    const tag = "pfui" + Date.now();
    const post = async (path, body) => (await serverRequest("POST", path, { ...body, user: "e2e" }));
    const item = (await post("/api/erp/items", { code: tag, name: "화면검증품목", unit: "EA" })).item.id;
    const loc = (await post("/api/erp/locations", { name: tag + "창고" })).location.id;
    await post("/api/erp/stock/adjust", { itemId: item, locationId: loc, type: "in", qty: 50 });
    const q = (await post("/api/erp/quotations", { date: "2032-07-01", partnerName: "화면 고객 " + tag, locationId: loc, items: [{ itemId: item, qty: 10, unitPrice: 2000 }] })).quotation;
    await post(`/api/erp/quotations/${q.id}/send`, {});
    await post(`/api/erp/quotations/${q.id}/accept`, {});
    await loadErpFromServer();
    gotoPage("sales-quotations");
    return { id: q.id, item, loc, tag };
  });
  const row = page.locator("#sales-quotations-tbl tr", { hasText: seed.tag });
  await expect(row).toBeVisible();
  await expect(row).toContainText("수주");

  // 잔여(10)를 초과하는 수량은 모달에서 바로 막힌다.
  await row.getByRole("button", { name: "출고/매출 처리" }).click();
  const qty = page.locator("#erp-ful-qty-0");
  await expect(qty).toHaveValue("10");
  await qty.fill("11");
  await page.getByRole("button", { name: "출고 처리" }).click();
  await expect(toast(page)).toContainText("잔여 수량(10)을 초과");

  // 4개만 1차 출고 → 부분출고
  await qty.fill("4");
  await page.getByRole("button", { name: "출고 처리" }).click();
  await expect(toast(page)).toContainText("출고 처리 및 세금계산서 발행이 완료");
  await expect(row).toContainText("부분출고");
  await expect(row.getByRole("button", { name: "추가 출고" })).toBeVisible();

  // 나머지 전부(기본값=잔여 6) 2차 출고 → 출고완료
  await row.getByRole("button", { name: "추가 출고" }).click();
  await expect(page.locator("#erp-ful-qty-0")).toHaveValue("6");
  await page.getByRole("button", { name: "출고 처리" }).click();
  await expect(row).toContainText("출고완료");
  await expect(row.getByRole("button", { name: "추가 출고" })).toHaveCount(0);

  // 보기 모달에 회차 2건이 표시된다.
  await row.getByRole("button", { name: "보기" }).click();
  const modal = page.locator(".modal-box").last();
  await expect(modal).toContainText("1차");
  await expect(modal).toContainText("2차");
  await modal.getByRole("button", { name: "닫기" }).click();

  // 1차분(4개) 중 5개 반품은 불가, 3개는 가능
  await row.getByRole("button", { name: "반품" }).click();
  await page.selectOption("#erp-ret-round", "1");
  await page.fill("#erp-ret-qty-0", "5");
  await page.fill("#erp-ret-reason", "화면 반품 시험");
  await page.getByRole("button", { name: "반품 처리" }).last().click();
  await expect(toast(page)).toContainText("반품 가능 수량(4)을 초과");
  await page.fill("#erp-ret-qty-0", "3");
  await page.getByRole("button", { name: "반품 처리" }).last().click();
  await page.locator("section.modal button", { hasText: "반품 처리" }).click();
  await expect(toast(page)).toContainText("수정세금계산서 발행이 완료");

  const state = await page.evaluate(async seed => {
    const stock = (await serverRequest("GET", "/api/erp/stock")).stock.find(r => r.itemId === seed.item && r.locationId === seed.loc)?.qty;
    const invoices = (await serverRequest("GET", "/api/accounting/tax-invoices")).taxInvoices.filter(t => t.sourceId === seed.id);
    return { stock, invoices: invoices.map(t => ({ kind: t.invoiceKind || "normal", supply: t.supplyTotal })) };
  }, seed);
  expect(state.stock).toBe(43); // 50 - 10 + 3
  expect(state.invoices.filter(t => t.kind === "normal").map(t => t.supply).sort((a, b) => a - b)).toEqual([8000, 12000]);
  expect(state.invoices.filter(t => t.kind === "amendment").map(t => t.supply)).toEqual([-6000]);

  // 세금계산서 화면: 수정 배지가 보이고 수정세금계산서에는 취소 버튼이 없다.
  await page.evaluate(() => { gotoPage("acct-tax-invoices"); });
  const amendRow = page.locator("#acct-tax-invoices-tbl tr", { hasText: "수정" }).first();
  await expect(amendRow).toBeVisible();
  await expect(amendRow.getByRole("button", { name: "취소" })).toHaveCount(0);

  expect(pageErrors).toEqual([]);
});

test("발주서 부분 입고 후 추가 입고와 반품 버튼이 상태에 맞게 나타난다", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", e => pageErrors.push(e.message));
  await loginAsAdmin(page);
  const seed = await page.evaluate(async () => {
    const tag = "pfpo" + Date.now();
    const post = async (path, body) => (await serverRequest("POST", path, { ...body, user: "e2e" }));
    const item = (await post("/api/erp/items", { code: tag, name: "발주검증품목", unit: "EA" })).item.id;
    const loc = (await post("/api/erp/locations", { name: tag + "창고" })).location.id;
    const po = (await post("/api/erp/purchase-orders", { date: "2032-08-01", partnerName: "화면 공급사 " + tag, locationId: loc, items: [{ itemId: item, qty: 8, unitPrice: 500 }] })).purchaseOrder;
    await post(`/api/erp/purchase-orders/${po.id}/confirm`, {});
    await loadErpFromServer();
    gotoPage("sales-purchase-orders");
    return { tag };
  });
  const row = page.locator("#sales-po-tbl tr", { hasText: seed.tag });
  await expect(row).toContainText("발주확정");
  await expect(row.getByRole("button", { name: "반품" })).toHaveCount(0);
  await row.getByRole("button", { name: "입고처리" }).click();
  await page.fill("#erp-ful-qty-0", "3");
  await page.getByRole("button", { name: "입고 처리" }).click();
  await expect(row).toContainText("부분입고");
  await expect(row.getByRole("button", { name: "추가 입고" })).toBeVisible();
  await expect(row.getByRole("button", { name: "반품" })).toBeVisible();
  await expect(row.getByRole("button", { name: "취소" })).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});
