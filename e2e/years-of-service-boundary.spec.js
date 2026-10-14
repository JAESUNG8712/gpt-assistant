const { test, expect } = require("@playwright/test");

// 2026-10-12 종합 고도화 리뷰에서 발견한 근속연수 계산 중복/불일치 수정의 회귀 테스트.
// 장기근속 포상 등 4개 화면이 각자 `(now-hire)/(1000*60*60*24*365)`를 복붙해 쓰고 있었는데,
// 밀리초 평균값 근사(윤년 보정 없음)라 경계일 근처에서 실제보다 1년 더 쳐주는 경우가 있었다
// — 입사일을 "오늘로부터 정확히 10년 뒤 기념일이 내일인" 날짜로 매 실행마다 동적으로
// 계산한다(과거에는 "2016-10-14"를 하드코딩해 테스트를 작성한 날짜(2026-10-13) 기준으로만
// 맞았는데, 다음날(2026-10-14, 정확히 그 기념일) 이후로는 입사일로부터 실제 10년이 지나
// yearsBetweenDates()가 정확히 "10년"을 반환하는 게 옳은데도 테스트는 여전히 "9년"을
// 기대해 매일 실패하는 상태가 됐었다 — 날짜를 하드코딩한 테스트 자체의 결함, 애플리케이션
// 로직의 결함이 아니었다). 옛 계산식은 그 사이에 쌓인 윤일 때문에 기념일이 되기도 전에
// "10년"으로 반올림해 보여줬다(실제로는 아직 만 9년). 공용 yearsBetweenDates()로 바꾼
// 뒤에는 달력 기념일 기준으로 정확히 9년만 표시돼야 한다.
function hireDateOneDayBeforeTenthAnniversary(now) {
  const d = new Date(now);
  d.setDate(d.getDate() + 1); // 내일(=10주년 기념일이 될 날)
  d.setFullYear(d.getFullYear() - 10); // 그 날짜의 10년 전 == 입사일
  return d.toISOString().slice(0, 10);
}
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

    // 매 실행 시점의 실제 날짜를 기준으로 "10주년 기념일이 내일인" 입사일을 계산한다
    // (하드코딩된 과거 날짜 대신 — 위 주석 참고, 날짜가 지나가도 영구히 유효해야 함).
    const hireDate = hireDateOneDayBeforeTenthAnniversary(new Date());

    await page.evaluate((hire) => {
      settings.longServiceAwards = [
        { years: 9, reward: "9년차 포상" },
        { years: 10, reward: "10년차 포상" },
      ];
      employees.push({
        id: 9950, empNo: "E9950", name: "경계일직원", dept: "비교테스트부서", team: "",
        rank: "과장", position: "", active: true, hire, hrHistory: [],
      });
    }, hireDate);

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
