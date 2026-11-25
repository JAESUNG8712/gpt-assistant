const { test, expect } = require("./fixtures");

// 연차 사용촉진 안내 메일 설정 토글(관리자 전용, 연차 관리 화면). 켜고 끈 값이 서버 설정에
// 실제로 저장되고 화면 라벨과 일치하는지 확인한다. 발송 자체는 test/api-leave-promotion-notice.test.js가 검증.

async function loginAsAdmin(page) {
  await page.goto("/");
  await page.fill("#l-id", "e2e_admin");
  await page.fill("#l-pw", "E2eTestPw123");
  // 확립된 관례: 로그인 직후 실제 loadFromServer로 revision을 동기화한 뒤 테스트 상태를 덧붙인다.
  await page.evaluate(() => {
    autoSaveDebounced = () => {};
    connectSSE = async () => {};
  });
  await page.click(".login-card button.btn-primary");
  await expect(page.locator("#main")).toBeVisible({ timeout: 10000 });
  await page.evaluate(() => loadFromServer());
  await page.evaluate(() => {
    loadFromServer = async () => {};
  });
}

test.describe("연차 사용촉진 안내 메일 설정 토글", () => {
  test("관리자가 켜고 끄면 서버 설정에 저장되고 라벨이 바뀐다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await loginAsAdmin(page);
    await page.evaluate(() => gotoPage("leave-mgmt"));
    // 연차 관리는 본인 확인 메뉴 — 사용자와 같이 로그인 비밀번호로 한 번 확인한다.
    const gate = page.locator("#my-pw-gate");
    if (await gate.count()) {
      await gate.fill("E2eTestPw123");
      await page.getByRole("button", { name: "확인", exact: true }).click();
    }

    const card = page.locator(".card", { hasText: "연차 사용촉진 안내 메일 자동 발송" });
    await expect(card).toBeVisible();
    await expect(card).toContainText("사용 안 함");

    await card.locator("input[type=checkbox]").check();
    await expect(card).toContainText("사용 중");
    let saved = await page.evaluate(async () => (await serverRequest("GET", "/data")).data.settings?.leavePromotionMail);
    expect(saved?.enabled).toBe(true);

    await card.locator("input[type=checkbox]").uncheck();
    await expect(card).toContainText("사용 안 함");
    saved = await page.evaluate(async () => (await serverRequest("GET", "/data")).data.settings?.leavePromotionMail);
    expect(saved?.enabled).toBe(false);

    expect(pageErrors).toEqual([]);
  });
});
