const { test, expect } = require("@playwright/test");

async function loginAsAdmin(page) {
  await page.goto("/");
  await page.fill("#l-id", "e2e_admin");
  await page.fill("#l-pw", "E2eTestPw123");
  // 서버에는 저장하지 않는다(공유 서버 상태 오염 방지) — 화면 동작만 검증한다.
  await page.evaluate(() => { autoSaveDebounced = () => {}; loadFromServer = async () => {}; connectSSE = async () => {}; _doSave = async () => {}; autoSaveToServerIfEnabled = () => {}; });
  await page.click(".login-card button.btn-primary");
  await expect(page.locator("#main")).toBeVisible({ timeout: 10000 });
  await page.evaluate(() => {
    employees.push({ id: 9701, name: "연결테스트", empNo: "RL001", role: "member", active: true, dept: "영업본부", team: "A팀", hrHistory: [] });
    exitInterviews = [];
  });
}

async function retire(page) {
  await page.evaluate(() => openRetireModal(9701));
  await page.selectOption("#rt-reason", "자진 퇴사");
  await page.locator(".modal-foot button", { hasText: "퇴직 처리" }).click();
}

test("퇴직 처리 직후 면담 기록으로 바로 이어지고 사유가 미리 채워진다", async ({ page }) => {
  await loginAsAdmin(page);
  await retire(page);
  await expect(page.locator(".modal-head h2", { hasText: "퇴직 면담 기록" })).toBeVisible();
  await page.getByRole("button", { name: "지금 기록", exact: true }).click();
  await expect(page.locator("#ei-emp")).toHaveValue("9701");
  await expect(page.locator("#ei-detail")).toHaveValue("퇴직 처리 시 사유: 자진 퇴사");
  expect(await page.evaluate(() => currentPage)).toBe("exit-interviews");
});

test("면담 안내를 거절하면 퇴직 처리만 남고, 이미 면담 기록이 있으면 묻지 않는다", async ({ page }) => {
  await loginAsAdmin(page);
  await retire(page);
  await expect(page.locator(".modal-head h2", { hasText: "퇴직 면담 기록" })).toBeVisible();
  await page.getByRole("button", { name: "취소", exact: true }).click();
  expect(await page.evaluate(() => getEmp(9701).active)).toBe(false);
  expect(await page.evaluate(() => exitInterviews.length)).toBe(0);
  // 이미 기록이 있는 경우: 재직으로 되돌려 다시 퇴직 처리해도 안내가 없다
  await page.evaluate(() => { employees = employees.map(e => e.id === 9701 ? { ...e, active: true } : e); exitInterviews = [{ id: "x1", empId: 9701, status: "done" }]; });
  await retire(page);
  await expect(page.locator(".modal-head h2", { hasText: "퇴직 면담 기록" })).toHaveCount(0);
});

test("직원 상세에 퇴직자의 면담 상태가 표시되고 바로 이동할 수 있다", async ({ page }) => {
  await loginAsAdmin(page);
  await page.evaluate(() => { employees = employees.map(e => e.id === 9701 ? { ...e, active: false, retireDate: "2026-01-02" } : e); openEmpDetail(9701); });
  await expect(page.locator(".modal-body")).toContainText("기록된 퇴직 면담이 없습니다");
  await page.getByRole("button", { name: "면담 기록", exact: true }).click();
  await expect(page.locator("#ei-emp")).toHaveValue("9701");
  await page.evaluate(() => { closeModal(); exitInterviews = [{ id: "x2", empId: 9701, status: "done", interviewDate: "2026-01-05", interviewerName: "담당", reasonCategory: "growth", rehireEligible: "yes" }]; openEmpDetail(9701); });
  await expect(page.locator(".modal-body")).toContainText("면담 완료");
  await expect(page.getByRole("button", { name: "면담 보기·수정", exact: true })).toBeVisible();
  // 재직자 상세에는 면담 영역이 없다
  await page.evaluate(() => { closeModal(); employees = employees.map(e => e.id === 9701 ? { ...e, active: true } : e); openEmpDetail(9701); });
  await expect(page.locator(".modal-body")).not.toContainText("퇴직 면담");
});
