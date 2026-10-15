const { test, expect } = require("@playwright/test");

test("HR 알림은 담당 업무와 메뉴 권한에 맞게 보이고 키보드로 이동된다", async ({ page }) => {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/");
  await page.fill("#l-id", "e2e_admin");
  await page.fill("#l-pw", "E2eTestPw123");
  await page.click(".login-card button.btn-primary");
  await expect(page.locator("#main")).toBeVisible({ timeout: 10000 });
  await page.waitForTimeout(750);

  await page.evaluate(() => {
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    currentUser.menuPerms = {};
    settings.mandatoryTrainingTypes = [];
    _recruitLoaded = true;
    employmentRecords = [{ id: "contract-notice", employeeId: currentUser.id, type: "contract", status: "active", reviewStatus: "open", endDate: today }];
    learningAssignments = [{ id: "training-notice", empId: currentUser.id, status: "assigned", dueDate: today }];
    positionRequests = [{ id: "position-notice", status: "submitted", submittedAt: today }];
    engagementActions = [{ id: "action-notice", ownerId: currentUser.id, status: "in_progress", dueDate: today }];
    gotoPage("notification-center");
  });
  await expect(page.getByRole("button", { name: /계약 만료 검토 1건/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /교육 이수 기한 확인 1건/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /정원 요청 승인 대기 1건/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /조직 개선계획 마감 예정 1건/ })).toBeVisible();

  await page.evaluate(() => {
    currentUser.menuPerms = { "employment-records": false };
    renderNotificationCenterPage();
  });
  await expect(page.getByRole("button", { name: /계약 만료 검토/ })).toHaveCount(0);
  const learning = page.getByRole("button", { name: /교육 이수 기한 확인 1건/ });
  await learning.focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate(() => currentPage)).toBe("learning-center");
  expect(errors).toEqual([]);
});
