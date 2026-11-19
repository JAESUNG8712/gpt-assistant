const { test, expect } = require("@playwright/test");

async function loginAsAdmin(page) {
  await page.goto("/");
  await page.fill("#l-id", "e2e_admin");
  await page.fill("#l-pw", "E2eTestPw123");
  // 서버에는 저장하지 않는다(공유 서버 상태 오염 방지) — 화면 동작만 검증한다.
  await page.evaluate(() => { autoSaveDebounced = () => {}; loadFromServer = async () => {}; connectSSE = async () => {}; _doSave = async () => {}; });
  await page.click(".login-card button.btn-primary");
  await expect(page.locator("#main")).toBeVisible({ timeout: 10000 });
  await page.evaluate(() => {
    const d = new Date(Date.now() - 5 * 86400000); const ymd = _localDateStr(d);
    employees.push({ id: "ex-emp1", name: "퇴직<b>자</b>", empNo: "EX001", role: "member", active: false, retireDate: ymd, dept: "영업본부", team: "A팀" });
    exitInterviews = [];
  });
}

test("퇴직 면담: 기록 없는 퇴직자에서 면담을 기록하면 목록·통계에 반영된다", async ({ page }) => {
  await loginAsAdmin(page);
  await page.evaluate(() => gotoPage("exit-interviews"));
  await expect(page.locator("#content")).toContainText("기록된 퇴직 면담이 없습니다");
  await expect(page.locator("#content")).toContainText("면담 기록이 없는 퇴직자");
  expect(await page.locator("#content b").count()).toBe(0); // 이름은 이스케이프된다
  await page.locator("#content button", { hasText: "퇴직" }).first().click();
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.locator(".toast").last()).toContainText("퇴직 사유를 선택");
  await page.selectOption("#ei-reason", "growth");
  await page.fill("#ei-detail", "성장 기회 부족 <img src=x onerror=window.__exxss=1>");
  await page.selectOption("#ei-sat", "4");
  await page.selectOption("#ei-rec", "yes");
  await page.selectOption("#ei-rehire", "yes");
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await expect.poll(() => page.evaluate(() => exitInterviews.length)).toBe(1);
  const saved = await page.evaluate(() => exitInterviews[0]);
  expect(saved).toMatchObject({ empId: "ex-emp1", status: "done", reasonCategory: "growth", satisfaction: 4, wouldRecommend: "yes", rehireEligible: "yes", dept: "영업본부" });
  const content = page.locator("#content");
  await expect(content).toContainText("성장·커리어");
  await expect(content).toContainText("100%"); // 추천 의향·사유 비율
  expect(await page.evaluate(() => window.__exxss)).toBeUndefined();
  await expect(content).not.toContainText("면담 기록이 없는 퇴직자");
});

test("퇴직 면담: 통계 계산과 연도 필터", async ({ page }) => {
  await loginAsAdmin(page);
  const st = await page.evaluate(() => _exitStats([
    { status: "done", reasonCategory: "pay", satisfaction: 2, wouldRecommend: "no", rehireEligible: "no" },
    { status: "done", reasonCategory: "pay", satisfaction: 4, wouldRecommend: "yes", rehireEligible: "yes" },
    { status: "done", reasonCategory: "culture", satisfaction: 3, wouldRecommend: "yes", rehireEligible: "hold" },
    { status: "scheduled", reasonCategory: "" },
  ]));
  expect(st).toMatchObject({ total: 4, done: 3, avgSat: 3, recommendYes: 2, recommendTotal: 3, rehireYes: 1 });
  expect(st.byReason.pay).toBe(2);
  await page.evaluate(() => {
    exitInterviews = [
      { id: "a", empId: "ex-emp1", empName: "가", status: "done", reasonCategory: "pay", retireDate: "2025-03-01" },
      { id: "b", empId: "ex-emp1", empName: "나", status: "done", reasonCategory: "culture", retireDate: "2026-03-01" },
    ];
    window._exitYear = "2026"; gotoPage("exit-interviews");
  });
  await expect(page.locator("#content tbody")).toContainText("나");
  await expect(page.locator("#content tbody")).not.toContainText("가");
  await page.evaluate(() => { window._exitYear = ""; });
});

test("퇴직 면담: 알림센터 안내와 삭제", async ({ page }) => {
  await loginAsAdmin(page);
  await page.evaluate(() => { gotoPage("notification-center"); });
  await expect(page.locator("#content")).toContainText("퇴직 면담 미기록");
  // 같은 직원에 기록이 생기면 안내가 사라진다
  await page.evaluate(() => {
    exitInterviews = [{ id: "z", empId: "ex-emp1", empName: "삭제대상", status: "done", reasonCategory: "pay", retireDate: "2026-03-01" }];
    gotoPage("notification-center");
  });
  await expect(page.locator("#content")).not.toContainText("퇴직 면담 미기록");
  // 확인창에서 삭제하면 기록이 제거된다
  await page.evaluate(() => { deleteExitInterview("z"); });
  await page.locator("section.modal").getByRole("button", { name: "확인" }).click();
  await expect.poll(() => page.evaluate(() => exitInterviews.length)).toBe(0);
});
