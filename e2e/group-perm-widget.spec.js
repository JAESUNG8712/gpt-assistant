const { test, expect } = require("@playwright/test");

test.describe("직군별/직책별 권한·위젯 일괄 관리", () => {
  test("직군별 메뉴 권한을 일괄 적용하면 소속 재직자 전원에게 반영된다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", e => pageErrors.push(e.message));

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

    await page.evaluate(() => {
      employees = employees.concat([
        { id: 9101, empNo: "E9101", name: "영업사원A", dept: "영업본부", team: "영업1팀", jobGroup: "영업직", position: "", active: true, role: "member", menuPerms: {} },
        { id: 9102, empNo: "E9102", name: "영업사원B", dept: "영업본부", team: "영업2팀", jobGroup: "영업직", position: "", active: true, role: "member", menuPerms: { kpi: false } },
        { id: 9103, empNo: "E9103", name: "개발자A", dept: "R&D본부", team: "개발팀", jobGroup: "개발직", position: "", active: true, role: "member", menuPerms: {} },
      ]);
    });

    await page.evaluate(() => gotoPage("deploy-perm"));
    await expect(page.locator("h3", { hasText: "메뉴 접근 권한 관리" })).toBeVisible({ timeout: 5000 });

    // Switch to jobGroup tab within the "메뉴 접근 권한 관리" card specifically (there are two "직군별" tabs on this page).
    const permCard = page.locator(".card", { hasText: "메뉴 접근 권한 관리" });
    await permCard.locator(".tab-btn", { hasText: "🧩 직군별" }).click();
    const groupSelect = permCard.locator("select").filter({ has: page.locator("option", { hasText: "영업직" }) }).first();
    await groupSelect.selectOption({ label: "영업직 (2명)" });

    await expect(permCard.locator("text=재직자")).toContainText("2명");

    // Uncheck the whole "평가"(KPI/역량평가) category via its header checkbox — BIG_CATEGORIES labels
    // this group "평가" (not "KPI 평가"), so match on the actual rendered label.
    const evalCategoryRow = page.locator("#group-perm-matrix > div", { hasText: "평가" }).first();
    const evalCategoryCheckbox = evalCategoryRow.locator("input[type=checkbox]").first();
    await evalCategoryCheckbox.uncheck();

    await permCard.locator("button", { hasText: /대상자 2명에게 일괄 적용/ }).click();
    const confirmModal = page.locator(".modal", { hasText: "직군별 메뉴 권한 일괄 적용" });
    await expect(confirmModal).toBeVisible();
    await confirmModal.locator("button", { hasText: "적용" }).click();

    await page.waitForTimeout(300);

    const result = await page.evaluate(() => {
      const a = employees.find(e => e.id === 9101);
      const b = employees.find(e => e.id === 9102);
      const c = employees.find(e => e.id === 9103);
      return {
        aPerms: a.menuPerms,
        bPerms: b.menuPerms,
        cPerms: c.menuPerms,
        template: settings.groupMenuPermTemplates,
      };
    });
    // Both sales employees should now have the KPI category items denied.
    const kpiPageIds = ["eval-progress", "kpi", "first-eval", "second-eval", "kpi-amend", "my-kpi", "grade-view"];
    const someKpiDenied = (perms) => kpiPageIds.some(id => perms[id] === false);
    expect(someKpiDenied(result.aPerms)).toBe(true);
    expect(someKpiDenied(result.bPerms)).toBe(true);
    // 개발직 employee must be untouched.
    expect(result.cPerms).toEqual({});
    expect(result.template.jobGroup["영업직"]).toBeTruthy();

    expect(pageErrors, `콘솔 페이지 에러 발생: ${pageErrors.join("; ")}`).toHaveLength(0);
  });

  test("직책별 기본 위젯을 일괄 적용하면 소속 재직자 전원에게 반영된다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", e => pageErrors.push(e.message));

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

    await page.evaluate(() => {
      orgDB.positions = Array.from(new Set([...(orgDB.positions || []), "테스트팀장"]));
      employees = employees.concat([
        { id: 9201, empNo: "E9201", name: "팀장A", dept: "영업본부", team: "영업1팀", position: "테스트팀장", jobGroup: "영업직", active: true, role: "leader", dashWidgets: ["my_kpi"] },
        { id: 9202, empNo: "E9202", name: "팀장B", dept: "R&D본부", team: "개발팀", position: "테스트팀장", jobGroup: "개발직", active: true, role: "leader", dashWidgets: [] },
      ]);
    });

    await page.evaluate(() => gotoPage("deploy-perm"));
    await expect(page.locator("h3", { hasText: "메인화면 기본 위젯 관리" })).toBeVisible({ timeout: 5000 });

    const widgetCard = page.locator(".card", { hasText: "메인화면 기본 위젯 관리" });
    await widgetCard.locator(".tab-btn", { hasText: "🏷 직책별" }).click();
    const groupSelect = widgetCard.locator("select").filter({ has: page.locator("option", { hasText: "테스트팀장" }) }).first();
    await groupSelect.selectOption({ label: "테스트팀장 (2명)" });

    // Uncheck board_updates, check hr_stats (admin-only widget — should still apply harmlessly, filtered at render for non-admin)
    const boardCheckbox = page.locator("label", { hasText: "게시판 업데이트" }).locator("input[type=checkbox]");
    if (await boardCheckbox.isChecked()) await boardCheckbox.uncheck();
    const hrStatsCheckbox = page.locator("label", { hasText: "인사 현황 통계" }).locator("input[type=checkbox]");
    await hrStatsCheckbox.check();

    await widgetCard.locator("button", { hasText: /대상자 2명에게 일괄 적용/ }).click();
    const confirmModal = page.locator(".modal", { hasText: "직책별 기본 위젯 일괄 적용" });
    await expect(confirmModal).toBeVisible();
    await confirmModal.locator("button", { hasText: "적용" }).click();

    await page.waitForTimeout(300);

    const result = await page.evaluate(() => {
      const a = employees.find(e => e.id === 9201);
      const b = employees.find(e => e.id === 9202);
      return { aWidgets: a.dashWidgets, bWidgets: b.dashWidgets, template: settings.groupDashWidgetTemplates };
    });
    expect(result.aWidgets).toContain("hr_stats");
    expect(result.aWidgets).not.toContain("board_updates");
    expect(result.bWidgets).toEqual(result.aWidgets);
    expect(result.template.position["테스트팀장"]).toEqual(result.aWidgets);

    expect(pageErrors, `콘솔 페이지 에러 발생: ${pageErrors.join("; ")}`).toHaveLength(0);
  });
});
