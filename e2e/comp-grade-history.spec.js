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

// Epic B #6(과거시점 평가결과): "역량평가 등급" 화면(renderCompGradeView)이 지금까지는
// settings.compEvalYear(현재 설정연도)만 보여줘, 과거 연도의 확정된 역량평가 결과를
// 조회하려면 회사 전체의 운영 설정값 자체를 바꿔야만 했다 — KPI 등급 현황(grade-view)에는
// 이미 있던 연도 선택 드롭다운을 이식해 과거 연도를 설정 변경 없이 그대로 조회 가능하게
// 한다. compGradeResults에 adjustedBy가 있는 레코드는 calcCompGradesForAll()이 건드리지
// 않는 멱등 함수이므로, 과거 연도를 선택해도 저장된 확정 결과가 그대로 보여야 한다.
test.describe("Epic B #6 — 역량평가 등급 화면의 과거시점 조회", () => {
  async function seedOrg(page) {
    await page.evaluate(() => {
      settings.compEvalYear = 2026;
      employees.push({
        id: 9601, empNo: "E9601", name: "역사조회대상", dept: "개발본부", team: "A1팀",
        rank: "대리", position: "", active: true, hire: "2019-01-01", hrHistory: [], role: "member",
      });
      compSessions.push(
        { id: 8101, year: 2024, targetId: 9601, type: "comp", evaluatorIds: [1], status: "closed", createdAt: "2024-11-01", updatedAt: "2024-11-01" },
        { id: 8102, year: 2026, targetId: 9601, type: "comp", evaluatorIds: [1], status: "closed", createdAt: "2026-11-01", updatedAt: "2026-11-01" },
      );
      compResponses.push(
        { id: 9101, sessionId: 8101, evaluatorId: 1, submittedAt: "2024-11-05" },
        { id: 9102, sessionId: 8102, evaluatorId: 1, submittedAt: "2026-11-05" },
      );
      compGradeResults[9601] = {
        "2024": { score: 88, grade: "A", adjustedBy: 1, adjustedByName: "관리자", adjustReason: "2024년도 확정", adjustedAt: "2024-12-01" },
        "2026": { score: 60, grade: "C", adjustedBy: 1, adjustedByName: "관리자", adjustReason: "2026년도 확정", adjustedAt: "2026-12-01" },
      };
    });
  }

  test("연도 드롭다운으로 과거 연도의 확정 결과를 설정 변경 없이 조회할 수 있다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await loginAsAdmin(page);
    await seedOrg(page);

    await page.evaluate(() => gotoPage("comp-grade-view"));

    // 기본값은 settings.compEvalYear(2026) — 과거 연도 조회 전에도 회사 운영 설정은 그대로다.
    const yearSelect = page.locator("#content .filter-bar select").first();
    await expect(yearSelect).toHaveValue("2026");
    await expect(page.locator("#content tbody tr", { hasText: "역사조회대상" })).toContainText("60점");
    await expect(page.locator("#content tbody tr", { hasText: "역사조회대상" })).toContainText("✏ 수정됨");

    // 드롭다운에 데이터가 있는 두 연도(2024/2026)가 모두 노출된다.
    const yearOptions = await yearSelect.locator("option").allTextContents();
    expect(yearOptions).toContain("2024년");
    expect(yearOptions).toContain("2026년");

    // 2024년으로 전환 — settings.compEvalYear는 그대로 2026임에도 2024년 확정 결과가 보여야 한다.
    await yearSelect.selectOption("2024");
    await expect(page.locator("#content tbody tr", { hasText: "역사조회대상" })).toContainText("88점");
    expect(await page.evaluate(() => settings.compEvalYear)).toBe(2026);

    // "🔄 등급 재산정"을 과거 연도에 눌러도 adjustedBy가 있는 확정 결과는 그대로 유지된다
    // (calcCompGradesForAll의 멱등성 — 과거 데이터를 조회만 해도 조용히 덮어쓰지 않음을 검증).
    await page.click("button:has-text('🔄 등급 재산정')");
    await expect(page.locator("#content tbody tr", { hasText: "역사조회대상" })).toContainText("88점");
    await expect(page.locator("#content tbody tr", { hasText: "역사조회대상" })).toContainText("✏ 수정됨");

    expect(pageErrors).toEqual([]);
  });

  test("등급 다운로드(CSV)도 현재 선택된 과거 연도 기준으로 생성된다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await loginAsAdmin(page);
    await seedOrg(page);

    await page.evaluate(() => gotoPage("comp-grade-view"));
    await page.locator("#content .filter-bar select").first().selectOption("2024");

    await page.evaluate(() => {
      window.__csvCalls = [];
      dlCSV = async (fn, headers, rows) => { window.__csvCalls.push({ fn, headers, rows }); };
    });
    await page.click("button:has-text('📥 등급 다운로드')");

    const calls = await page.evaluate(() => window.__csvCalls);
    expect(calls.length).toBe(1);
    expect(calls[0].fn).toContain("2024년");
    expect(calls[0].rows.length).toBe(1);
    expect(calls[0].rows[0][8]).toBe("A"); // grade 컬럼 — 2026년의 "C"가 아니라 2024년의 "A"

    expect(pageErrors).toEqual([]);
  });
});
