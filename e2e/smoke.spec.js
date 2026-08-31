// P1-3 e2e 스캐폴드의 최소 스모크 테스트. playwright.config.js의 webServer가
// test/support/start-e2e-server.js로 서버를 띄우고(관리자 e2e_admin/E2eTestPw123
// 사전 시딩됨), 여기서는 그 서버를 상대로 실제 브라우저 로그인·기본 네비게이션만
// 확인한다. 화면별 상세 시나리오는 이 스캐폴드 위에 추가해 나가면 된다.
const { test, expect } = require("@playwright/test");

test.describe("로그인·기본 네비게이션", () => {
  test("hosted 앱은 ?srv와 저장된 서버 URL 대신 same-origin API만 사용한다", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => localStorage.setItem("hr_kpi_server_url", "https://evil.example"));
    await page.goto("/?srv=https%3A%2F%2Fevil.example");

    const config = await page.evaluate(() => ({
      url: serverConfig.url,
      effective: _effectiveServerUrl(),
      locked: _isServerUrlLocked(),
      stored: localStorage.getItem("hr_kpi_server_url"),
      shared: Boolean(window._isSharedDeployLink),
    }));

    expect(config.locked).toBe(true);
    expect(config.url).toBe(new URL(page.url()).origin);
    expect(config.effective).toBe(new URL(page.url()).origin);
    expect(config.stored).toBeNull();
    expect(config.shared).toBe(false);
  });

  test("로그인 레이블과 공용 알림이 보조기기에 연결된다", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator('label[for="l-company"]')).toBeVisible();
    await expect(page.locator('label[for="l-id"]')).toBeVisible();
    await expect(page.locator('label[for="l-pw"]')).toBeVisible();

    await page.evaluate(() => showToast("저장 완료", "success"));
    await expect(page.locator('.toast[role="status"][aria-live="polite"]')).toContainText("저장 완료");
    await page.evaluate(() => showToast("저장 실패", "error"));
    await expect(page.locator('.toast[role="alert"][aria-live="assertive"]')).toContainText("저장 실패");
  });

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

  test("모바일 메뉴와 공용 모달을 키보드로 닫을 수 있다", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/");
    await page.fill("#l-id", "e2e_admin");
    await page.fill("#l-pw", "E2eTestPw123");
    await page.click(".login-card button.btn-primary");
    await expect(page.locator("#main")).toBeVisible({ timeout: 10000 });

    const menu = page.locator("#mobile-menu-btn");
    await expect(menu).toHaveAttribute("aria-expanded", "false");
    await menu.click();
    await expect(menu).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator("#sidebar")).toHaveClass(/open/);
    await page.keyboard.press("Escape");
    await expect(menu).toHaveAttribute("aria-expanded", "false");

    await page.evaluate(() => showModal('<section class="modal modal-sm"><div class="modal-head"><h2>접근성 검사</h2><button class="modal-close" onclick="closeModal()">×</button></div><div class="modal-body"><button type="button">확인</button></div></section>'));
    await expect(page.locator("[role=dialog][aria-modal=true]")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("[role=dialog]")).toHaveCount(0);
  });

  test("동시 수정 충돌은 최신 데이터를 다시 읽고 사용자 선택 모달을 표시한다", async ({ page }) => {
    await page.goto("/");
    await page.fill("#l-id", "e2e_admin");
    await page.fill("#l-pw", "E2eTestPw123");
    await page.click(".login-card button.btn-primary");
    await expect(page.locator("#main")).toBeVisible({ timeout: 10000 });

    await page.evaluate(() => _handleRecordRevisionConflict({
      field: "boardPosts",
      id: "e2e-concurrent-record",
      currentRevision: 2,
    }));

    const dialog = page.locator('[role="dialog"][aria-modal="true"]');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("다른 사용자가");
    await expect(dialog.getByRole("button", { name: "서버 최신 내용 유지" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "내 변경 다시 적용" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator('[role="dialog"]')).toHaveCount(0);
  });
});
