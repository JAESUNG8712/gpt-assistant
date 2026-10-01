const { test, expect } = require("@playwright/test");

test("관리자가 펄스 설문을 개설하고 익명 임계치 집계를 확인한다", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.goto("/");
  await page.fill("#l-id", "e2e_admin");
  await page.fill("#l-pw", "E2eTestPw123");
  await page.evaluate(() => { autoSaveDebounced = () => {}; loadFromServer = async () => {}; connectSSE = async () => {}; });
  await page.click(".login-card button.btn-primary");
  await expect(page.locator("#main")).toBeVisible();

  await page.evaluate(() => gotoPage("engagement-pulse"));
  await expect(page.getByRole("heading", { name: "💬 직원 몰입도 펄스" })).toBeVisible();
  await expect(page.locator("#content")).toContainText("관리자와 리더에게 개인 응답은 제공되지 않습니다");

  await page.getByRole("button", { name: "＋ 설문 개설" }).click();
  await page.fill("#pulse-title", "2026년 10월 몰입도");
  await page.getByRole("button", { name: "개설" }).click();
  await expect(page.locator("#content")).toContainText("2026년 10월 몰입도");
  await expect(page.locator("#content")).toContainText("응답 0명");

  await page.evaluate(() => {
    const id = engagementSurveys[0].id;
    engagementPulseSummary[id] = { responseCount: 3, threshold: 3, thresholdMet: true, driverAverages: { engagement: 8.3, clarity: 7.7 }, comments: ["회의 집중시간이 필요합니다."] };
    renderEngagementPulsePage();
  });
  await expect(page.locator("#content")).toContainText("8.3");
  await expect(page.locator("#content")).toContainText("익명 개선 의견 (1건)");
  await expect(page.locator("#content")).toContainText("회의 집중시간이 필요합니다.");

  await page.getByRole("button", { name: "＋ 개선계획" }).click();
  await expect(page.locator("#content").getByRole("heading", { name: "설문 개선계획 작성" })).toBeVisible();
  await page.fill("#pulse-action-title", "매주 월요일 팀 우선순위 공유");
  await page.selectOption("#pulse-action-driver", "clarity");
  await page.fill("#pulse-action-metric", "주간 공유율 90% 이상");
  await page.getByRole("button", { name: "개선계획 등록" }).click();
  await expect(page.locator("#content")).toContainText("매주 월요일 팀 우선순위 공유");
  await expect(page.locator("#content")).toContainText("결과 기반 개선계획 (1건)");

  await page.getByRole("button", { name: "상세·점검" }).click();
  await expect(page.locator("#content").getByRole("heading", { name: "매주 월요일 팀 우선순위 공유" })).toBeVisible();
  await expect(page.locator("#content")).toContainText("주간 공유율 90% 이상");
  await page.fill("#pulse-action-progress", "40");
  await page.fill("#pulse-action-note", "첫 주 우선순위 공유를 완료했습니다.");
  await page.fill("#pulse-action-next-step", "공유 양식을 더 간단하게 정리합니다.");
  await page.getByRole("button", { name: "점검 기록 저장" }).click();
  await expect(page.locator("#content")).toContainText("첫 주 우선순위 공유를 완료했습니다.");
  await expect(page.locator("#content")).toContainText("진행 중");
  await expect(page.locator("#content")).toContainText("40%");
  expect(pageErrors).toEqual([]);
});
