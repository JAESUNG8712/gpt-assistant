const { test, expect } = require("./fixtures");

// 코드 정리 중 발견한 실제 런타임 오류의 회귀 테스트.
// 1) PMS 프로젝트 종료 확인창이 제거된 pmsAllocations 참조로 열리지 않던 문제.
// 2) KPI 등급 수동 조정이 정의되지 않은 str() 호출로 저장 전에 실패하던 문제.

async function loginAsAdmin(page) {
  await page.goto("/");
  await page.fill("#l-id", "e2e_admin");
  await page.fill("#l-pw", "E2eTestPw123");
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

test.describe("코드 정리 회귀", () => {
  test("PMS 프로젝트 종료 확인창이 열리고 예외 없이 동작한다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await loginAsAdmin(page);

    const projectId = await page.evaluate(async () => {
      const r = await serverRequest("POST", "/api/pms/projects", {
        name: "정리회귀종료테스트", startDate: "2026-01-01", endDate: "2026-12-31", memo: "",
      });
      return r.project.id;
    });
    await page.evaluate(async () => {
      pmsProjects = (await serverRequest("GET", "/api/pms/projects")).projects || [];
    });

    // closePmsProject는 확인창 응답까지 기다리는 비동기 함수라, 결과를 기다리지 않고 호출만 한다.
    await page.evaluate((id) => { closePmsProject(id); }, projectId);
    const modal = page.locator('[role="dialog"][aria-modal="true"]');
    await expect(modal).toContainText("PMS 프로젝트 종료 확인");
    await expect(modal).toContainText("정리회귀종료테스트");
    expect(pageErrors).toEqual([]);
  });

  test("KPI 등급 수동 조정이 예외 없이 등급과 이력을 기록한다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await loginAsAdmin(page);

    await page.evaluate(() => {
      employees.push({ id: "cleanup-emp-1", name: "정리회귀직원", role: "member", active: true, dept: "영업본부", team: "영업1팀", hire: "2020-01-01", gradeResults: {} });
    });
    await page.evaluate(() => adjustKpiGrade("cleanup-emp-1", 2026, "A", "정리 회귀 테스트"));

    const result = await page.evaluate(() => ({
      grade: employees.find((e) => e.id === "cleanup-emp-1")?.gradeResults?.["2026"]?.grade,
      history: gradeAdjustHistory.filter((h) => h.empId === "cleanup-emp-1").length,
    }));
    expect(result.grade).toBe("A");
    expect(result.history).toBe(1);
    expect(pageErrors).toEqual([]);
  });
});
