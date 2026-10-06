const { test, expect } = require("@playwright/test");

// 목표별 등급기준표(앵커링 자동채점, Epic C — HR마인드 벤치마킹). settings.kpiAchievementBands
// (달성률 % → 점수 매핑 구간표)가 "KPI 결과 입력" 화면에서 제안 점수로만 작동하고(강제 자동
// 적용 아님), "평가 단계 설정" 화면에서 관리자가 편집·검증할 수 있는지 확인한다.

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

test.describe("목표별 등급기준표(앵커링 자동채점)", () => {
  test("달성율을 숫자로 입력하면 구간표 기준 제안 점수가 뜨고, 적용 버튼으로 자체평가 점수칸에 채워진다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await loginAsAdmin(page);

    await page.evaluate(() => {
      settings.evalYear = 2026;
      settings.stage = "performance";
      kpiEntries.push({ id: 7701, userId: currentUser.id, year: 2026, item: "매출목표", weight: 100, goal: "100억", prev: "", yoy: "", strategy: "", evalCriteria: "", actual: "", rate: "", detail: "", selfScore: null, firstStatus: "", finalStatus: "", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    });

    await page.evaluate(() => openKpiResult(7701));
    await expect(page.locator("#kr-rate")).toBeVisible();

    // 기본 구간표: 100%이상~110%미만 => 90점
    await page.fill("#kr-rate", "105");
    await page.locator("#kr-rate").dispatchEvent("input");
    await expect(page.locator("#kr-rate-suggest")).toContainText("90점");

    // 비숫자 자유 텍스트는 제안이 조용히 사라진다(기존 자유 텍스트 호환).
    await page.fill("#kr-rate", "초과달성");
    await page.locator("#kr-rate").dispatchEvent("input");
    await expect(page.locator("#kr-rate-suggest")).toHaveText("");

    await page.fill("#kr-rate", "105");
    await page.locator("#kr-rate").dispatchEvent("input");
    await page.click("#kr-rate-suggest button:has-text('적용')");
    await expect(page.locator("#kr-self")).toHaveValue("90");

    expect(pageErrors).toEqual([]);
  });

  test("관리자는 평가 단계 설정 화면에서 구간표를 편집·저장할 수 있고, 최하위(0% 이하) 구간이 없으면 저장이 막힌다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await loginAsAdmin(page);

    await page.evaluate(() => gotoPage("eval-ops"));
    await page.evaluate(() => renderKpiStageSettings());
    await expect(page.locator("#settings-content")).toContainText("달성률 자동채점 구간(앵커링)");

    // 최하위 구간(0% 이하)을 100%로 바꿔 무효화한 뒤 저장 시도 → 차단되어야 한다.
    await page.evaluate(() => {
      const lowest = _kpiStageDraft.bands.find(b => Number(b.min) <= 0);
      lowest.min = 50;
    });
    await page.evaluate(() => kpiStageSaveAll());
    const stillDefault = await page.evaluate(() => settings.kpiAchievementBands == null);
    expect(stillDefault).toBe(true); // 검증 실패로 저장되지 않아 설정이 비어있는 상태 그대로

    // 유효한 구간표로 복원 후 저장 — 실제 반영 확인.
    await page.evaluate(() => {
      _kpiStageDraft.bands = [{ min: 100, score: 95 }, { min: 0, score: 50 }];
      kpiStageSaveAll();
    });
    const saved = await page.evaluate(() => settings.kpiAchievementBands);
    expect(saved).toEqual([{ min: 100, score: 95 }, { min: 0, score: 50 }]);

    // 저장된 새 구간표가 실제 제안 점수 계산에 반영되는지 확인(99% → 50점, 100% → 95점).
    const score99 = await page.evaluate(() => kpiAutoScoreFromRate("99"));
    const score100 = await page.evaluate(() => kpiAutoScoreFromRate("100%"));
    expect(score99).toBe(50);
    expect(score100).toBe(95);

    expect(pageErrors).toEqual([]);
  });
});
