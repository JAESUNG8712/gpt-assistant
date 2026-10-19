const { test, expect } = require("@playwright/test");

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

// 서버가 일부 항목을 되돌릴 때 사용자에게 id 한 줄이 아니라 "왜"를 보여주는지 검증한다.
test("저장 거부 배너와 사유 모달이 사유를 보여주고 입력값을 이스케이프한다", async ({ page }) => {
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await loginAsAdmin(page);
  await page.evaluate(() => {
    boardPosts.push({ id: "bp-x", title: "<img src=x onerror=window.__xss=1>", content: "", authorId: "a" });
    const rows = _recordSaveRejections([
      { field: "boardPosts", id: "bp-x", reason: "PERMISSION", level: "error", message: "저장 권한이 없어 반영되지 않았습니다.", fields: ["title"] },
      { field: "learningAssignments", id: "w1", reason: "TRAINING_WAITLISTED", level: "info", message: "정원이 가득 차 대기 신청으로 접수되었습니다.", fields: [] },
    ]);
    _saveRejectBannerShow(rows, false);
  });
  const banner = page.locator("#save-reject-banner");
  await expect(banner).toContainText("일부 항목이 저장되지 않았습니다 (1건)");
  await banner.getByText("사유 보기").click();
  const modal = page.locator(".modal-ov");
  await expect(modal).toContainText("저장 권한이 없어 반영되지 않았습니다.");
  await expect(modal).toContainText("대기 신청으로 접수");
  await expect(modal).toContainText("제목");
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  await expect(page.locator("#save-reject-banner")).toHaveCount(0);
  expect(errors).toEqual([]);
});
