const { test, expect } = require("@playwright/test");

test.describe("우수사원 등록 - 이름 검색 선택", () => {
  test("openOrgPicker로 대상자를 검색·선택하고 정상 등록된다", async ({ page }) => {
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

    // Seed two employees with distinct names for search-matching.
    await page.evaluate(() => {
      employees = employees.concat([
        { id: 9001, empNo: "E9001", name: "김테스트", dept: "테스트부", team: "검색팀", active: true, hrHistory: [] },
        { id: 9002, empNo: "E9002", name: "박검색", dept: "테스트부", team: "검색팀", active: true, hrHistory: [] },
      ]);
    });

    await page.evaluate(() => gotoPage("welfare-settings"));
    await page.locator(".tab-btn", { hasText: "🏆 우수사원" }).click();
    await page.click("text=+ 선정 등록");

    const modal = page.locator(".modal-box", { hasText: "(최)우수사원 선정 등록" });
    await expect(modal).toBeVisible();
    await expect(modal.locator("#award-emp-badge")).toHaveText("미지정");
    await expect(page.locator("select#award-emp")).toHaveCount(0);
    await expect(page.locator("input#award-emp[type=hidden]")).toHaveCount(1);

    await modal.locator("button", { hasText: "이름 검색" }).click();
    const picker = page.locator(".modal-box", { hasText: "우수사원 대상자 선택" });
    await expect(picker).toBeVisible();
    await picker.locator("#op-search").fill("박검색");
    await expect(picker.locator("#op-tree")).toContainText("박검색");
    await expect(picker.locator("#op-tree")).not.toContainText("김테스트");
    await picker.locator("#op-tree label", { hasText: "박검색" }).click();
    await picker.locator("button", { hasText: "선택 완료" }).click();

    await expect(picker).toBeHidden();
    await expect(modal.locator("#award-emp-badge")).toHaveText("박검색 (테스트부/검색팀)");
    await expect(page.locator("input#award-emp[type=hidden]")).toHaveValue("9002");

    await modal.locator("#award-year").fill("2025");
    await modal.locator("#award-half").selectOption("상반기");
    await modal.locator("#award-tier").selectOption("최우수");
    await modal.locator("#award-reason").fill("검색선택 테스트 사유");
    await modal.locator("button", { hasText: "등록" }).click();
    await page.waitForTimeout(300);

    const saved = await page.evaluate(() => {
      const emp = employees.find((e) => e.id === 9002);
      return (emp.hrHistory || []).filter((h) => h.type === "award");
    });
    expect(saved.length).toBe(1);
    expect(saved[0].tier).toBe("최우수");
    expect(saved[0].year).toBe(2025);
    expect(saved[0].half).toBe("상반기");

    await page.click("text=+ 선정 등록");
    const modal2 = page.locator(".modal-box", { hasText: "(최)우수사원 선정 등록" });
    await expect(modal2.locator("#award-emp-badge")).toHaveText("미지정");
    await page.click("text=취소");

    expect(pageErrors, `콘솔 페이지 에러 발생: ${pageErrors.join("; ")}`).toHaveLength(0);
  });
});
