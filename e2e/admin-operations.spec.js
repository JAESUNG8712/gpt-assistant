const { test, expect } = require("@playwright/test");

test("관리자 운영센터가 상태·보안·활동 통계를 표시하고 필터링한다", async ({ page }) => {
  const pageErrors=[];
  page.on("pageerror", error=>pageErrors.push(error.message));
  await page.goto("/");
  await page.fill("#l-id", "e2e_admin");
  await page.fill("#l-pw", "E2eTestPw123");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page.locator("#topbar-username")).toBeVisible();

  await page.evaluate(()=>gotoPage("admin-operations"));
  await expect(page.getByRole("heading", { name: "🛡 관리자 운영센터" })).toBeVisible();
  await expect(page.getByText("서비스 상태", { exact: true })).toBeVisible();
  await expect(page.getByText("관리자 2단계 인증", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "접속·활동 이력" })).toBeVisible();
  await expect(page.locator("tbody")).toContainText("로그인 성공");

  await page.fill("#admin-ops-query", "존재하지않는검색어");
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await expect(page.getByText("조건에 맞는 이력이 없습니다.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "초기화", exact: true }).click();
  await expect(page.locator("tbody")).toContainText("로그인 성공");
  expect(pageErrors).toEqual([]);
});
