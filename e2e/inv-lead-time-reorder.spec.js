const { test, expect } = require("@playwright/test");

// 작업3(항목C) — 재고 리드타임 + 반자동 구매요청(재주문점 계산 + 원클릭 생성).
// erp_items/erp_stock_ledger/erp_purchase_requests는 전용 REST 테이블(employees처럼
// /save 전체상태 블롭을 거치지 않음)이라, loadFromServer()를 로그인 전에 완전히
// 막아도 안전하다(이 세 컬렉션은 그 블롭과 무관).
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

test.describe("재고 리드타임 + 반자동 구매요청", () => {
  test("_erpReorderPoint(순수함수): 리드타임 미설정/출고이력 없음은 안전재고 부족분으로 폴백, 리드타임+출고이력이 있으면 재주문점이 커진다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await loginAsAdmin(page);

    const result = await page.evaluate(() => {
      const now = Date.parse("2026-06-01T00:00:00Z");
      const noLeadTime = _erpReorderPoint({ safetyStock: 20, leadTimeDays: 0 }, [], now);
      const leadTimeNoHistory = _erpReorderPoint({ safetyStock: 20, leadTimeDays: 10 }, [], now);
      const leadTimeWithHistory = _erpReorderPoint(
        { safetyStock: 20, leadTimeDays: 10 },
        [{ type: "out", qty: 90, createdAt: "2026-05-15T00:00:00Z" }],
        now
      );
      // 90일 윈도우 밖(예: 200일 전)의 출고는 집계에서 제외돼야 한다.
      const outsideWindow = _erpReorderPoint(
        { safetyStock: 20, leadTimeDays: 10 },
        [{ type: "out", qty: 900, createdAt: "2025-11-01T00:00:00Z" }],
        now
      );
      // 입고(in)는 소비량 계산에 포함되지 않아야 한다.
      const inboundIgnored = _erpReorderPoint(
        { safetyStock: 20, leadTimeDays: 10 },
        [{ type: "in", qty: 500, createdAt: "2026-05-15T00:00:00Z" }],
        now
      );
      return { noLeadTime, leadTimeNoHistory, leadTimeWithHistory, outsideWindow, inboundIgnored };
    });

    expect(result.noLeadTime).toEqual({ reorderPoint: 20, dailyUsage: 0, leadTimeApplied: false });
    expect(result.leadTimeNoHistory).toEqual({ reorderPoint: 20, dailyUsage: 0, leadTimeApplied: false });
    expect(result.leadTimeWithHistory.leadTimeApplied).toBe(true);
    expect(result.leadTimeWithHistory.dailyUsage).toBe(1); // 90개/90일
    expect(result.leadTimeWithHistory.reorderPoint).toBe(30); // 20 + 1*10
    expect(result.outsideWindow).toEqual({ reorderPoint: 20, dailyUsage: 0, leadTimeApplied: false });
    expect(result.inboundIgnored).toEqual({ reorderPoint: 20, dailyUsage: 0, leadTimeApplied: false });

    expect(pageErrors).toEqual([]);
  });

  test("품목에 리드타임을 설정해 저장하면 품목 관리 화면에 반영되고 CSV에도 포함된다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await loginAsAdmin(page);

    await page.evaluate(() => {
      window.__csvCalls = [];
      dlCSV = (filename, headers, rows) => { window.__csvCalls.push({ filename, headers, rows }); };
    });

    await page.evaluate(() => gotoPage("inv-items"));
    await page.click("button:has-text('+ 품목 추가')");
    await page.fill("#item-code", "LT-001");
    await page.fill("#item-name", "리드타임테스트품목");
    await page.fill("#item-safety", "20");
    await page.fill("#item-leadtime", "10");
    await page.click(".modal-foot >> button:has-text('저장')");
    await expect(page.locator(".toast").last()).toContainText("저장되었습니다");

    const row = page.locator("tr", { hasText: "리드타임테스트품목" });
    await expect(row).toContainText("10"); // 리드타임(일) 열

    await page.click("button:has-text('📥 엑셀 다운로드')");
    const csvResult = await page.evaluate(() => window.__csvCalls[0]);
    expect(csvResult.headers).toContain("리드타임(일)");
    const ltIdx = csvResult.headers.indexOf("리드타임(일)");
    const dataRow = csvResult.rows.find((r) => r[0] === "LT-001");
    expect(dataRow[ltIdx]).toBe(10);

    expect(pageErrors).toEqual([]);
  });

  test("재고 현황: 리드타임 반영 품목은 배지와 더 큰 추천 발주량이 표시되고, 리드타임 미설정 품목은 기존 단순 부족분 그대로 표시된다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await loginAsAdmin(page);

    const seeded = await page.evaluate(async () => {
      const loc = await serverRequest("POST", "/api/erp/locations", { name: "재고리드타임테스트창고" });
      const itemA = await serverRequest("POST", "/api/erp/items", {
        code: "LT-A", name: "리드타임적용품목", safetyStock: 20, leadTimeDays: 10, unitCost: 1000,
      });
      const itemB = await serverRequest("POST", "/api/erp/items", {
        code: "LT-B", name: "리드타임미설정품목", safetyStock: 20, leadTimeDays: 0, unitCost: 500,
      });
      const locId = loc.location.id;
      // 둘 다 입고 100 → 출고 90(itemA만) → 현재고 10으로 동일하게 "부족" 상태를 만든다.
      await serverRequest("POST", "/api/erp/stock/adjust", { itemId: itemA.item.id, locationId: locId, type: "in", qty: 100 });
      await serverRequest("POST", "/api/erp/stock/adjust", { itemId: itemA.item.id, locationId: locId, type: "out", qty: 90 });
      await serverRequest("POST", "/api/erp/stock/adjust", { itemId: itemB.item.id, locationId: locId, type: "in", qty: 100 });
      await serverRequest("POST", "/api/erp/stock/adjust", { itemId: itemB.item.id, locationId: locId, type: "out", qty: 90 });
      await loadErpFromServer();
      return { itemAId: itemA.item.id, itemBId: itemB.item.id, locId };
    });

    await page.evaluate(() => gotoPage("inv-stock"));
    await page.waitForSelector("#inv-stock-tbl table");

    const rowA = page.locator("tr", { hasText: "LT-A 리드타임적용품목" });
    await expect(rowA).toContainText("20"); // safetyStock(20)+dailyUsage(1)*leadTime(10)-현재고(10)=20
    await expect(rowA).toContainText("⏱ 리드타임 반영");

    const rowB = page.locator("tr", { hasText: "LT-B 리드타임미설정품목" });
    await expect(rowB).toContainText("10"); // safetyStock(20)-현재고(10)=10, 리드타임 미적용
    await expect(rowB).not.toContainText("⏱ 리드타임 반영");

    expect(pageErrors).toEqual([]);
  });

  test("단일 품목 '📝 구매요청' 버튼: 모달이 추천 발주량으로 미리 채워지고, '요청 제출'을 누르기 전까지는 서버에 아무것도 생성되지 않는다(반자동)", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await loginAsAdmin(page);

    const seeded = await page.evaluate(async () => {
      const loc = await serverRequest("POST", "/api/erp/locations", { name: "단일구매요청테스트창고" });
      const item = await serverRequest("POST", "/api/erp/items", {
        code: "PR-SINGLE", name: "단일구매요청테스트품목", safetyStock: 20, leadTimeDays: 10, unitCost: 2000,
      });
      const locId = loc.location.id;
      await serverRequest("POST", "/api/erp/stock/adjust", { itemId: item.item.id, locationId: locId, type: "in", qty: 100 });
      await serverRequest("POST", "/api/erp/stock/adjust", { itemId: item.item.id, locationId: locId, type: "out", qty: 90 });
      await loadErpFromServer();
      return { itemId: item.item.id };
    });

    await page.evaluate(() => gotoPage("inv-stock"));
    await page.waitForSelector("#inv-stock-tbl table");
    const row = page.locator("tr", { hasText: "단일구매요청테스트품목" });
    await row.getByRole("button", { name: "📝 구매요청" }).click();

    await expect(page.locator("#pr-items input[placeholder='수량']")).toHaveValue("20");
    await expect(page.locator("#pr-items input[placeholder='단가']")).toHaveValue("2000");
    await expect(page.locator(".modal-body")).toContainText("추천 발주량으로 미리 채워진 초안입니다");

    // 아직 제출 전 — 서버에 이 품목의 구매요청이 생성되지 않았어야 한다(반자동 증명).
    const beforeSubmit = await page.evaluate(async (itemId) => {
      const r = await serverRequest("GET", "/api/erp/purchase-requests");
      return r.purchaseRequests.some((pr) => (pr.lines || []).some((l) => l.itemId === itemId));
    }, seeded.itemId);
    expect(beforeSubmit).toBe(false);

    await page.click(".modal-foot >> button:has-text('요청 제출')");
    await expect(page.locator(".toast").last()).toContainText("제출되었습니다");

    const afterSubmit = await page.evaluate(async (itemId) => {
      const r = await serverRequest("GET", "/api/erp/purchase-requests");
      const pr = r.purchaseRequests.find((p) => (p.lines || []).some((l) => l.itemId === itemId));
      return pr ? pr.lines.find((l) => l.itemId === itemId) : null;
    }, seeded.itemId);
    expect(afterSubmit).toBeTruthy();
    expect(afterSubmit.qty).toBe(20);

    expect(pageErrors).toEqual([]);
  });

  test("여러 부족 품목을 체크박스로 선택해 '선택 항목 일괄 구매요청'을 누르면 하나의 모달에 모두 담긴다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await loginAsAdmin(page);

    const seeded = await page.evaluate(async () => {
      const loc = await serverRequest("POST", "/api/erp/locations", { name: "일괄구매요청테스트창고" });
      const item1 = await serverRequest("POST", "/api/erp/items", {
        code: "PR-BULK-1", name: "일괄구매요청품목1", safetyStock: 20, leadTimeDays: 0, unitCost: 100,
      });
      const item2 = await serverRequest("POST", "/api/erp/items", {
        code: "PR-BULK-2", name: "일괄구매요청품목2", safetyStock: 30, leadTimeDays: 0, unitCost: 200,
      });
      const locId = loc.location.id;
      for (const it of [item1, item2]) {
        await serverRequest("POST", "/api/erp/stock/adjust", { itemId: it.item.id, locationId: locId, type: "in", qty: 100 });
        await serverRequest("POST", "/api/erp/stock/adjust", { itemId: it.item.id, locationId: locId, type: "out", qty: 90 });
      }
      await loadErpFromServer();
      return { item1Id: item1.item.id, item2Id: item2.item.id };
    });

    await page.evaluate(() => gotoPage("inv-stock"));
    await page.waitForSelector("#inv-stock-tbl table");
    await page.locator("tr", { hasText: "일괄구매요청품목1" }).locator(".inv-stock-chk").check();
    await page.locator("tr", { hasText: "일괄구매요청품목2" }).locator(".inv-stock-chk").check();
    await page.click("button:has-text('🧺 선택 항목 일괄 구매요청')");

    // openPurchaseRequestModal()이 모달 자체는 즉시 열지만 실제 입력란은
    // setTimeout(renderPRItems,30)으로 지연 렌더링한다 — .all()은 toHaveValue()류
    // 어서션과 달리 자동 재시도(auto-wait)를 하지 않으므로, 먼저 개수가 찰 때까지
    // 기다린 뒤에 읽어야 한다(이 레이스를 놓쳐 처음엔 .all()을 즉시 호출해 실패를
    // 재현했었음).
    const qtyLocator = page.locator("#pr-items input[placeholder='수량']");
    await expect(qtyLocator).toHaveCount(2);
    const qtyInputs = await qtyLocator.all();
    const values = await Promise.all(qtyInputs.map((el) => el.inputValue()));
    expect(values.sort()).toEqual(["10", "20"]); // safetyStock(20|30) - 현재고(10)

    expect(pageErrors).toEqual([]);
  });

  test("선택 없이 '선택 항목 일괄 구매요청'을 누르면 안내만 뜨고 모달이 열리지 않는다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await loginAsAdmin(page);
    await page.evaluate(() => gotoPage("inv-stock"));
    await page.waitForSelector("#inv-stock-tbl table");
    await page.click("button:has-text('🧺 선택 항목 일괄 구매요청')");
    await expect(page.locator(".toast").last()).toContainText("선택된 품목이 없습니다");
    await expect(page.locator(".modal-box")).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  });
});
