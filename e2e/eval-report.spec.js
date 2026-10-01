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

// Epic B #11(평가결과 리포트): KPI 등급(employees[].gradeResults)과 역량/리더십 등급
// (compGradeResults)이 지금까지 완전히 분리된 화면에서만 조회 가능해, 한 직원의 두 결과를
// 한눈에 보려면 두 화면을 오가야 했다. "역량평가" 관리 화면에 신설한 "통합 리포트" 탭이
// 두 저장소를 그대로 둔 채(신규 데이터 모델 없이) 한 화면·한 CSV로 합쳐서 보여주는지 검증한다.
//
// 이 e2e 스위트는 전체 spec 파일이 하나의 서버 프로세스·하나의 DATA_FILE을 공유하므로
// (다른 spec이 실제로 저장한 직원 레코드가 남아있을 수 있음), "전체 부서" 선택 시의
// 원본 전체 인원수를 단언하지 않는다 — 대신 이 테스트 전용의 고유한 부서명으로 먼저
// 필터링한 뒤 그 범위 안에서만 집계·행 내용을 검증한다(다른 spec 파일과 공유하는
// employees 배열의 나머지 내용과 무관하게 항상 재현 가능하도록).
test.describe("Epic B #11 — 평가 결과 통합 리포트", () => {
  const DEPT = "리포트대상부서_평가B11";
  const OTHER_DEPT = "리포트기타부서_평가B11";

  async function seedOrg(page) {
    await page.evaluate(({ DEPT, OTHER_DEPT }) => {
      settings.compEvalYear = 2026;
      employees.push(
        {
          id: 9701, empNo: "E9701", name: "리포트팀원", dept: DEPT, team: "A1팀",
          rank: "대리", position: "", active: true, hire: "2019-01-01", hrHistory: [], role: "member",
          gradeResults: { "2026": { score: 85, grade: "A" } },
        },
        {
          id: 9702, empNo: "E9702", name: "리포트사업부장", dept: DEPT, team: "",
          rank: "상무", position: "사업부장", active: true, hire: "2015-01-01", hrHistory: [], role: "director",
          gradeResults: { "2026": { score: 70, grade: "B" } },
        },
        {
          id: 9703, empNo: "E9703", name: "타부서직원", dept: OTHER_DEPT, team: "B1팀",
          rank: "사원", position: "", active: true, hire: "2021-01-01", hrHistory: [], role: "member",
          gradeResults: { "2026": { score: 60, grade: "C" } },
        },
      );
      compGradeResults[9701] = { "2026": { score: 92, grade: "S", adjustedBy: 1, adjustedByName: "관리자", adjustedAt: "2026-12-01" } };
      compGradeResults[9702] = { "2026": { score: 78, grade: "B", adjustedBy: 1, adjustedByName: "관리자", adjustedAt: "2026-12-01" } };
      compGradeResults[9703] = { "2026": { score: 55, grade: "D", adjustedBy: 1, adjustedByName: "관리자", adjustedAt: "2026-12-01" } };
    }, { DEPT, OTHER_DEPT });
  }

  test("통합 리포트가 KPI·역량·리더십 등급을 한 표에 합쳐 보여준다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await loginAsAdmin(page);
    await seedOrg(page);

    await page.evaluate(() => { compSelYear = 2026; compTab = "overview"; gotoPage("comp-eval"); });
    await page.click(".comp-tab-row button:has-text('통합 리포트')");
    await page.selectOption("#comp-content .filter-bar select", DEPT);

    // 부서 필터로 좁힌 2명(팀원+사업부장)만 노출 — 다른 spec이 남긴 무관한 직원 수와 무관.
    await expect(page.locator("#comp-content .filter-bar")).toContainText("총 2명");
    await expect(page.locator("#comp-content tbody tr", { hasText: "타부서직원" })).toHaveCount(0);

    const teamRow = page.locator("#comp-content tbody tr", { hasText: "리포트팀원" });
    await expect(teamRow).toContainText("85점"); // KPI 점수
    await expect(teamRow).toContainText("92점"); // 역량 점수
    await expect(teamRow).toContainText("역량");
    const dirRow = page.locator("#comp-content tbody tr", { hasText: "리포트사업부장" });
    await expect(dirRow).toContainText("70점");
    await expect(dirRow).toContainText("78점");
    await expect(dirRow).toContainText("리더십");

    // 요약 카드 — KPI 평균(85+70)/2=77.5, 역량/리더십 평균(92+78)/2=85 (필터링된 2명 기준)
    await expect(page.locator("#comp-content")).toContainText("평균 77.5점");
    await expect(page.locator("#comp-content")).toContainText("평균 85점");

    expect(pageErrors).toEqual([]);
  });

  test("리포트 다운로드(CSV)가 현재 필터·연도 기준으로 정확히 생성된다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await loginAsAdmin(page);
    await seedOrg(page);

    await page.evaluate(() => { compSelYear = 2026; compTab = "overview"; gotoPage("comp-eval"); });
    await page.click(".comp-tab-row button:has-text('통합 리포트')");
    await page.selectOption("#comp-content .filter-bar select", DEPT);

    await page.evaluate(() => {
      window.__csvCalls = [];
      dlCSV = async (fn, headers, rows) => { window.__csvCalls.push({ fn, headers, rows }); };
    });
    await page.click("button:has-text('📥 리포트 다운로드(CSV)')");

    const calls = await page.evaluate(() => window.__csvCalls);
    expect(calls.length).toBe(1);
    expect(calls[0].fn).toContain("2026년");
    expect(calls[0].fn).toContain(DEPT);
    // 부서 필터가 CSV에도 그대로 적용돼 다른 부서 직원(타부서직원)은 제외되고 정확히 2명만 남는다.
    const names = calls[0].rows.map((r) => r[0]);
    expect(names).toContain("리포트팀원");
    expect(names).toContain("리포트사업부장");
    expect(names).not.toContain("타부서직원");
    // rows 배열엔 다른 리포트 다운로드 함수들과 동일한 관례대로 제목행+빈행+컬럼헤더행
    // 3개가 데이터 행 앞에 붙는다(dlEvalReport 구현 참고) — 그 3개를 제외하면 정확히 2명분.
    expect(calls[0].rows.length - 3).toBe(2);
    const dirRow = calls[0].rows.find((r) => r[0] === "리포트사업부장");
    expect(dirRow[6]).toBe("리더십"); // 평가구분 컬럼
    expect(dirRow[8]).toBe("B"); // 평가등급 컬럼
    const teamRow = calls[0].rows.find((r) => r[0] === "리포트팀원");
    expect(teamRow[6]).toBe("역량");
    expect(teamRow[8]).toBe("S");

    expect(pageErrors).toEqual([]);
  });

  test("관리자가 아니면 통합 리포트 탭 자체가 노출되지 않는다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await loginAsAdmin(page);
    await seedOrg(page);

    // director로 세션을 전환해 "통합 리포트"가 admin 전용 탭 블록에서 제외되는지 확인한다.
    await page.evaluate(() => {
      currentUser = employees.find((e) => e.id === 9702);
      compSelYear = 2026; compTab = "overview"; gotoPage("comp-eval");
    });
    await expect(page.locator(".comp-tab-row")).not.toContainText("통합 리포트");

    expect(pageErrors).toEqual([]);
  });
});
