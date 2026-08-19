// P1-3 e2e 스캐폴드의 최소 스모크 테스트. playwright.config.js의 webServer가
// test/support/start-e2e-server.js로 서버를 띄우고(관리자 e2e_admin/E2eTestPw123
// 사전 시딩됨), 여기서는 그 서버를 상대로 실제 브라우저 로그인·기본 네비게이션만
// 확인한다. 화면별 상세 시나리오는 이 스캐폴드 위에 추가해 나가면 된다.
const { test, expect } = require("@playwright/test");

test.describe("로그인·기본 네비게이션", () => {
  test("잘못된 비밀번호는 오류를 보여준다", async ({ page }) => {
    await page.goto("/");
    await page.fill("#l-id", "e2e_admin");
    await page.fill("#l-pw", "wrong-password");
    await page.click(".login-card button.btn-primary");
    await expect(page.locator("#login-err")).toContainText(/./, { timeout: 5000 });
  });

  test("정상 로그인 후 대시보드가 렌더링되고 콘솔 에러가 없다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", e => pageErrors.push(e.message));

    await page.goto("/");
    await page.fill("#l-id", "e2e_admin");
    await page.fill("#l-pw", "E2eTestPw123");
    await page.click(".login-card button.btn-primary");

    await expect(page.locator("#main")).toBeVisible({ timeout: 10000 });
    await expect(page.locator("#topbar-username")).toContainText("E2E관리자");

    expect(pageErrors, `콘솔 페이지 에러 발생: ${pageErrors.join("; ")}`).toHaveLength(0);
  });

  test("인사관리 > 직원목록으로 이동해도 에러 없이 렌더링된다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", e => pageErrors.push(e.message));

    await page.goto("/");
    await page.fill("#l-id", "e2e_admin");
    await page.fill("#l-pw", "E2eTestPw123");
    await page.click(".login-card button.btn-primary");
    await expect(page.locator("#main")).toBeVisible({ timeout: 10000 });

    await page.evaluate(() => gotoPage("hr-list"));
    await expect(page.locator("#hr-list-search")).toBeVisible({ timeout: 5000 });
    await expect(page.locator("#hr-list-tbl")).toContainText("E2E관리자", { timeout: 5000 });

    expect(pageErrors, `콘솔 페이지 에러 발생: ${pageErrors.join("; ")}`).toHaveLength(0);
  });
});
