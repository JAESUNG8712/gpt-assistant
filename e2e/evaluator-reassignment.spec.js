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

// 서버 인증은 test/api-evaluator-reassignment.test.js가 이미 전부 검증했으므로, 이
// e2e는 "역할에 따라 올바른 탭/범위가 화면에 렌더링되는가"만 확인한다 — admin으로
// 로그인한 뒤 currentUser를 교체해 각 역할의 뷰를 재현하는 이 프로젝트의 기존 관례
// (org-chart-drag.spec.js의 member 뷰 검증, kpi-feedback-thread.spec.js의 무관 제3자
// 검증과 동일한 방식)를 그대로 따른다.
test.describe("Epic B #9 — 사업부장·팀장의 하위조직원 평가자 조정", () => {
  async function seedOrg(page) {
    await page.evaluate(() => {
      settings.compEvalYear = 2026;
      settings.compEvalEnabled = true;
      employees.push(
        { id: 9301, empNo: "E9301", name: "사업부장A", dept: "개발본부", team: "", rank: "", position: "", active: true, hire: "2015-01-01", hrHistory: [], role: "director" },
        { id: 9302, empNo: "E9302", name: "팀장A1", dept: "개발본부", team: "A1팀", rank: "과장", position: "팀장", active: true, hire: "2018-01-01", hrHistory: [], role: "leader" },
        { id: 9303, empNo: "E9303", name: "팀원A1-가", dept: "개발본부", team: "A1팀", rank: "사원", position: "", active: true, hire: "2021-01-01", hrHistory: [], role: "member" },
        { id: 9304, empNo: "E9304", name: "팀원A2-나(다른팀)", dept: "개발본부", team: "A2팀", rank: "사원", position: "", active: true, hire: "2021-01-01", hrHistory: [], role: "member" },
        { id: 9305, empNo: "E9305", name: "타부서직원", dept: "영업본부", team: "B1팀", rank: "사원", position: "", active: true, hire: "2021-01-01", hrHistory: [], role: "member" },
      );
      compSessions.push({ id: 8001, year: 2026, targetId: 9303, type: "comp", evaluatorIds: [9302], status: "open", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    });
  }

  test("director는 같은 dept 소속만 보이는 전용 탭을 갖고, admin 전용 관리 탭은 보이지 않는다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await loginAsAdmin(page);
    await seedOrg(page);

    await page.evaluate(() => {
      currentUser = { ...currentUser, id: 9301, role: "director", dept: "개발본부", team: "" };
      compTab = "overview";
    });
    await page.evaluate(() => gotoPage("comp-eval"));

    await expect(page.locator(".comp-tab-row button", { hasText: "하위조직원 평가자 조정" })).toBeVisible();
    await expect(page.locator(".comp-tab-row button", { hasText: "역량평가 관리" })).toHaveCount(0);
    await expect(page.locator(".comp-tab-row button", { hasText: "리더십평가 관리" })).toHaveCount(0);
    await expect(page.locator(".comp-tab-row button", { hasText: "평가 결과 조회" })).toHaveCount(0);

    await page.click(".comp-tab-row button:has-text('하위조직원 평가자 조정')");
    const rows = page.locator("#comp-content tbody tr");
    // 개발본부 소속(director 자신·director 역할 제외) — 팀장A1, 팀원A1-가, 팀원A2-나(다른팀) 3명.
    await expect(rows).toHaveCount(3);
    await expect(page.locator("#comp-content")).toContainText("팀장A1");
    await expect(page.locator("#comp-content")).toContainText("팀원A1-가");
    await expect(page.locator("#comp-content")).toContainText("팀원A2-나(다른팀)");
    await expect(page.locator("#comp-content")).not.toContainText("타부서직원");

    expect(pageErrors).toEqual([]);
  });

  test("leader는 같은 dept+team 소속만 보이는 더 좁은 범위를 갖는다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await loginAsAdmin(page);
    await seedOrg(page);

    await page.evaluate(() => {
      currentUser = { ...currentUser, id: 9302, role: "leader", dept: "개발본부", team: "A1팀" };
      compTab = "overview";
    });
    await page.evaluate(() => gotoPage("comp-eval"));

    await expect(page.locator(".comp-tab-row button", { hasText: "하위조직원 평가자 조정" })).toBeVisible();
    await page.click(".comp-tab-row button:has-text('하위조직원 평가자 조정')");

    const rows = page.locator("#comp-content tbody tr");
    await expect(rows).toHaveCount(1);
    await expect(page.locator("#comp-content")).toContainText("팀원A1-가");
    await expect(page.locator("#comp-content")).not.toContainText("팀원A2-나(다른팀)");
    await expect(page.locator("#comp-content")).not.toContainText("타부서직원");

    // 기존 세션(8001, evaluatorIds=[9302])이 있어 "세션없음" 배지 없이 평가자 수가 표시된다.
    await expect(page.locator("#comp-content")).toContainText("1");

    // "평가자 설정" 버튼 클릭 시 기존 openEvaluatorEditModal이 정상적으로 재사용된다.
    await page.click("button:has-text('평가자 설정')");
    await expect(page.locator(".modal-head h2")).toContainText("평가자 관리 — 팀원A1-가");
    await page.click(".modal-close");

    // "⚙ 기준 설정" 버튼도 기존 openEvaluatorConfigModal을 그대로 재사용한다.
    await page.click("button:has-text('⚙ 기준 설정')");
    await expect(page.locator(".modal-head h2")).toContainText("평가자 기준 설정");

    expect(pageErrors).toEqual([]);
  });

  test("member에게는 이 탭 자체가 보이지 않는다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await loginAsAdmin(page);
    await seedOrg(page);

    await page.evaluate(() => {
      currentUser = { ...currentUser, id: 9303, role: "member", dept: "개발본부", team: "A1팀" };
      compTab = "overview";
    });
    await page.evaluate(() => gotoPage("comp-eval"));

    await expect(page.locator(".comp-tab-row button", { hasText: "하위조직원 평가자 조정" })).toHaveCount(0);

    expect(pageErrors).toEqual([]);
  });
});
