const { test, expect } = require("@playwright/test");

// 2026-10-12 종합 고도화 리뷰에서 발견한 근속연수 계산 중복/불일치 수정의 회귀 테스트.
// 장기근속 포상 등 4개 화면이 각자 `(now-hire)/(1000*60*60*24*365)`를 복붙해 쓰고 있었는데,
// 밀리초 평균값 근사(윤년 보정 없음)라 경계일 근처에서 실제보다 1년 더 쳐주는 경우가
// 있었다 — 아래 입사일(2016-10-14)은 오늘(2026-10-13, 이 테스트 실행 환경의 고정 날짜)
// 기준으로 정확히 그 경계에 있다: 10주년 기념일(2016-10-14의 10년 뒤인 2026-10-14)이
// 아직 하루 남았는데도, 옛 계산식은 그 사이에 쌓인 윤일(2020-02-29, 2024-02-29) 때문에
// 이미 "10년"으로 반올림해 보여줬다(실제로는 아직 만 9년). 공용 yearsBetweenDates()로
// 바꾼 뒤에는 달력 기념일 기준으로 정확히 9년만 표시돼야 한다.
async function loginAsAdmin(page) {
  await page.goto("/");
  await page.fill("#l-id", "e2e_admin");
  await page.fill("#l-pw", "E2eTestPw123");
  // 로그인 직후 백그라운드 서버 재동기화(SSE/자동로드)가 테스트가 시딩한
  // 순수 인메모리 상태를 덮어쓰는 경합을 막는다(이 프로젝트의 확립된 관례).
  await page.evaluate(() => {
    autoSaveDebounced = () => {};
    loadFromServer = async () => {};
    connectSSE = async () => {};
  });
  await page.click(".login-card button.btn-primary");
  await expect(page.locator("#main")).toBeVisible({ timeout: 10000 });
}

test.describe("근속연수 계산 — 윤년 경계일 정확성", () => {
  test("입사 10주년 기념일을 아직 하루 채우지 못한 직원은 만 9년으로 표시된다(옛 계산식은 10년으로 반올림했었음)", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));

    await loginAsAdmin(page);

    await page.evaluate(() => {
      settings.longServiceAwards = [
        { years: 9, reward: "9년차 포상" },
        { years: 10, reward: "10년차 포상" },
      ];
      employees.push({
        id: 9950, empNo: "E9950", name: "경계일직원", dept: "비교테스트부서", team: "",
        rank: "과장", position: "", active: true, hire: "2016-10-14", hrHistory: [],
      });
    });

    await page.evaluate(() => gotoPage("long-service-award"));
    await page.fill('input[placeholder="이름/부서/팀 검색"]', "경계일직원");

    const row = page.locator("tr", { hasText: "경계일직원" });
    await expect(row).toContainText("9년", { timeout: 5000 });
    await expect(row).not.toContainText("10년");
    await expect(row).toContainText("9년 달성 — 9년차 포상");
    await expect(row).not.toContainText("10년차 포상");

    expect(pageErrors, `콘솔 에러: ${pageErrors.join(", ")}`).toHaveLength(0);
  });
});
