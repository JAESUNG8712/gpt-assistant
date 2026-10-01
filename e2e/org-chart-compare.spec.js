const { test, expect } = require("@playwright/test");

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

test.describe("조직도 두 시점 비교", () => {
  test("전보·승진·직책변동·입사·퇴사를 두 날짜 사이의 차이로 정확히 집계한다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));

    await loginAsAdmin(page);

    await page.evaluate(() => {
      orgDB.depts.push("비교전부서", "비교후부서", "비교직책부서");
      employees.push(
        // 전보+승진: 비교전부서/T1(사원) → 비교후부서/T2(대리), 2020-06-15에 발생.
        // 현재 레코드는 "이후" 상태를 그대로 담고, hrHistory.before가 "이전" 상태를 복원하는 데 쓰인다.
        {
          id: 9901, empNo: "E9901", name: "전보승진직원", dept: "비교후부서", team: "T2",
          rank: "대리", position: "", active: true, hire: "2019-01-01",
          hrHistory: [
            { id: "h1", type: "transfer", date: "2020-06-15", applied: true, before: "비교전부서/T1", after: "비교후부서/T2" },
            { id: "h2", type: "rank_change", date: "2020-06-15", applied: true, before: "사원", after: "대리" },
          ],
        },
        // 직책 변동: 없음 → 팀장, 부서/팀은 그대로 유지.
        {
          id: 9902, empNo: "E9902", name: "직책변동직원", dept: "비교직책부서", team: "",
          rank: "과장", position: "팀장", active: true, hire: "2018-01-01",
          hrHistory: [{ id: "h3", type: "position", date: "2020-06-15", applied: true, before: "없음", after: "팀장" }],
        },
        // 신규 입사: 비교 구간(2020-01-01~2020-12-31) 안인 2020-08-01 입사.
        {
          id: 9903, empNo: "E9903", name: "신규입사직원", dept: "비교직책부서", team: "",
          rank: "사원", position: "", active: true, hire: "2020-08-01", hrHistory: [],
        },
        // 퇴사: 비교 구간 안인 2020-09-01 퇴사.
        {
          id: 9904, empNo: "E9904", name: "퇴사직원", dept: "비교직책부서", team: "",
          rank: "사원", position: "", active: false, hire: "2015-01-01",
          retireDate: "2020-09-01", retireReason: "개인사유", hrHistory: [],
        },
      );
    });

    await page.evaluate(() => gotoPage("orgchart"));
    await page.click("text=📊 두 시점 비교");
    await expect(page.locator("#org-cmp-from")).toBeVisible();

    await page.fill("#org-cmp-from", "2020-01-01");
    await page.fill("#org-cmp-to", "2020-12-31");
    await page.click("text=비교하기");

    const result = page.locator("#org-cmp-result");
    await expect(result).toContainText("전체 인원");

    // 부서 증감: "비교전부서"는 소멸(1명→0명), "비교후부서"는 신설(0명→1명).
    await expect(result).toContainText("비교전부서");
    await expect(result).toContainText("소멸");
    await expect(result).toContainText("비교후부서");
    await expect(result).toContainText("신설");

    // 전보(부서·팀 이동)
    await expect(result).toContainText("전보승진직원");
    await expect(result).toContainText("비교전부서 / T1");
    await expect(result).toContainText("비교후부서 / T2");

    // 승진(직급 변동)
    await expect(result).toContainText("사원 → 대리");

    // 직책 변동
    await expect(result).toContainText("직책변동직원");
    await expect(result).toContainText("(없음) → 팀장");

    // 신규 입사
    await expect(result).toContainText("신규입사직원");
    await expect(result).toContainText("2020-08-01");

    // 퇴사
    await expect(result).toContainText("퇴사직원");
    await expect(result).toContainText("2020-09-01");

    expect(pageErrors).toEqual([]);
  });

  test("시작일이 종료일보다 늦거나 같으면 에러 토스트를 띄우고 비교를 진행하지 않는다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));

    await loginAsAdmin(page);
    // renderOrgChartPage()는 현재 시점 기준 재직자가 0명이면 조직도 자체를 그리지
    // 않고 "직원 데이터가 없습니다"만 표시하므로, 비교 버튼을 클릭하려면 최소 1명은 필요하다.
    await page.evaluate(() => {
      employees.push({ id: 9906, empNo: "E9906", name: "검증용직원", dept: "검증부서", team: "", rank: "사원", position: "", active: true, hire: "2019-01-01", hrHistory: [] });
    });
    await page.evaluate(() => gotoPage("orgchart"));
    await page.click("text=📊 두 시점 비교");

    await page.fill("#org-cmp-from", "2020-12-31");
    await page.fill("#org-cmp-to", "2020-01-01");
    await page.click("text=비교하기");
    await expect(page.locator(".toast-error")).toContainText("시작일은 종료일보다");
    await expect(page.locator("#org-cmp-result")).toBeEmpty();

    expect(pageErrors).toEqual([]);
  });
});
