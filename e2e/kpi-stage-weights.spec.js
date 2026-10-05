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
    autoSaveToServerIfEnabled = () => Promise.resolve();
  });
  await page.click(".login-card button.btn-primary");
  await expect(page.locator("#main")).toBeVisible({ timeout: 10000 });
}

// Epic B #4(종합점수 비율설정 완성)/#5(차수별 반영비율) — N단계 KPI 평가(Epic B #1/#5/#7, 이미
// 병합됨) 위에 쌓는 후속 작업. 두 부분으로 구성:
//  (A) _calcOverallScore()가 finalConfirmAll() 직후 KPI 비중을 조용히 잃어버리던 버그 수정
//      (finalConfirmAll은 kpiEntries의 finalScore를 null로 비우고 emp.gradeResults[year]에
//      이미 계산된 점수를 저장해두는데, 예전 코드는 그 저장값을 보지 않고 라이브
//      kpiEntries를 재계산해 KPI 가중치가 전부 사라졌었다).
//  (B) 차수별 반영비율(settings.kpiApprovalStages[i].weight) — 지금까지는 N단계 중 "최종
//      단계" 점수만 100% 반영되고 1차/중간 단계 점수는 전혀 쓰이지 않았는데, 관리자가
//      단계별 가중치를 설정해 블렌딩할 수 있게 한다. 기본값([0,...,0,100])은 기존 동작과
//      완전히 동일해야 한다(회귀 없음).
test.describe("Epic B #4/#5 — 종합점수 계산 보강 + 차수별 반영비율", () => {
  test("finalConfirmAll() 직후에도 종합점수의 KPI 비중이 사라지지 않는다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await loginAsAdmin(page);

    const result = await page.evaluate(() => {
      const YEAR = 2031;
      settings.evalYear = YEAR;
      settings.scoreWeights = { kpi: 60, comp: 40, ls: 0 }; // comp+ls가 항상 합산되므로(cW=comp+ls) ls는 0으로 둔다
      employees.push({
        id: 95301, empNo: "E95301", name: "종합점수검증", dept: "개발본부", team: "A팀",
        rank: "대리", position: "", active: true, hire: "2019-01-01", hrHistory: [], role: "member",
      });
      kpiEntries.push({
        id: 95401, userId: 95301, year: YEAR, item: "목표", weight: 100, goalSub: true,
        firstStatus: "approved", firstScore: 70,
        finalStatus: "approved", finalScore: 85, finalConfirmed: false, secondScore: 85,
        updatedAt: new Date().toISOString(),
      });
      compGradeResults[95301] = { [YEAR]: { score: 50, grade: "C" } };

      finalConfirmAll();

      const kpiAfter = kpiEntries.find(k => k.id === 95401);
      const overallAfter = _calcOverallScore(95301, YEAR);
      return {
        finalScoreAfter: kpiAfter.finalScore,
        finalConfirmedAfter: kpiAfter.finalConfirmed,
        gradeResultScore: (employees.find(e => e.id === 95301).gradeResults || {})[YEAR]?.score,
        overallAfter,
      };
    });

    // finalConfirmAll()이 finalScore를 비우고 finalConfirmed를 켜는 것 자체는 기존 동작 그대로.
    expect(result.finalScoreAfter).toBeNull();
    expect(result.finalConfirmedAfter).toBe(true);
    // gradeResults에는 확정 시점의 KPI 점수(85)가 그대로 보존된다.
    expect(result.gradeResultScore).toBe(85);
    // 핵심 회귀 검증 — 수정 전이었다면 kpiScore가 null이 되어 overallAfter가 comp점수(50)만
    // 반환했을 것(버그 재현값). 수정 후에는 (85×60+50×40)/100=71이 정확히 반영되어야 한다.
    expect(result.overallAfter).toBe(71);

    expect(pageErrors).toEqual([]);
  });

  test("gradeResults가 아직 없는 평가 진행 중 레코드는 라이브 kpiEntries에서 안전하게 재계산한다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await loginAsAdmin(page);

    const overall = await page.evaluate(() => {
      const YEAR = 2032;
      settings.scoreWeights = { kpi: 60, comp: 20, ls: 20 };
      employees.push({
        id: 95302, empNo: "E95302", name: "진행중검증", dept: "개발본부", team: "A팀",
        rank: "사원", position: "", active: true, hire: "2020-01-01", hrHistory: [], role: "member",
      });
      // finalConfirmed:true이지만(방어적 엣지케이스 — 정상 플로우에서는 finalConfirmAll을 통해서만
      // 함께 세팅됨) gradeResults는 아직 없는 상태 — 라이브 재계산 폴백 경로를 직접 확인한다.
      kpiEntries.push({
        id: 95402, userId: 95302, year: YEAR, item: "목표", weight: 100, goalSub: true,
        finalStatus: "approved", finalScore: 90, finalConfirmed: true, updatedAt: new Date().toISOString(),
      });
      compGradeResults[95302] = { [YEAR]: { score: 70, grade: "B" } };
      return _calcOverallScore(95302, YEAR);
    });
    // (90×60+70×40)/100 = 82
    expect(overall).toBe(82);

    expect(pageErrors).toEqual([]);
  });

  test("차수별 반영비율을 설정하면 1차·중간·최종 점수가 비율대로 블렌딩된다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await loginAsAdmin(page);

    const result = await page.evaluate(() => {
      const YEAR = 2033;
      settings.kpiApprovalStages = [
        { id: "s1", label: "1차", kind: "team_leader", weight: 30 },
        { id: "s2", label: "중간", kind: "specific_employee", approverEmpId: 999, weight: 20 },
        { id: "s3", label: "최종", kind: "dept_director", weight: 50 },
      ];
      const entry = {
        id: 95403, userId: 95303, year: YEAR, item: "목표", weight: 100, goalSub: true,
        firstStatus: "approved", firstScore: 100,
        middleStages: { s2: { score: 50, status: "approved" } },
        finalStatus: "approved", finalScore: 80,
        updatedAt: new Date().toISOString(),
      };
      kpiEntries.push(entry);
      const viaCalcWeighted = calcWeighted([entry]);
      const viaFinalScore = calcEmpFinalScore(95303, YEAR);
      return { viaCalcWeighted, viaFinalScore };
    });
    // 100×0.3 + 50×0.2 + 80×0.5 = 30+10+40 = 80
    expect(result.viaCalcWeighted).toBe(80);
    expect(result.viaFinalScore).toBe(80);

    expect(pageErrors).toEqual([]);
  });

  test("기본 2단계 구성(반영비율 미설정)은 기존 동작과 완전히 동일하다 — 1차 점수는 반영되지 않는다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await loginAsAdmin(page);

    const result = await page.evaluate(() => {
      const YEAR = 2034;
      delete settings.kpiApprovalStages; // 아예 설정한 적 없는 회사
      const entry = {
        id: 95404, userId: 95304, year: YEAR, item: "목표", weight: 100, goalSub: true,
        firstStatus: "approved", firstScore: 10, // 반영되면 안 됨(기존에도 무시되던 값)
        finalStatus: "approved", finalScore: 90,
        updatedAt: new Date().toISOString(),
      };
      kpiEntries.push(entry);
      return calcWeighted([entry]);
    });
    expect(result).toBe(90);

    expect(pageErrors).toEqual([]);
  });

  test("관리자 설정 화면에서 반영비율을 편집·저장할 수 있고, 합계가 100%가 아니면 저장이 차단된다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await loginAsAdmin(page);

    await page.evaluate(() => gotoPage("eval-ops"));
    await page.click(".tabs button:has-text('평가 단계 설정')");
    // 기본 2단계는 반영비율 0%/100%로 이미 채워져 있어(미설정 회사도 이 화면을 열면 항상
    // 유효한 값을 보여준다), 합계가 즉시 100%로 보인다.
    await expect(page.locator("#kpi-stage-weight-total")).toHaveText("100%");

    const weightInputs = page.locator("#settings-content input[type=number][min='0'][max='100']");
    await weightInputs.nth(0).fill("30");
    await weightInputs.nth(1).fill("70");
    await expect(page.locator("#kpi-stage-weight-total")).toHaveText("100%");
    await page.click("#settings-content button:has-text('저장')");
    await expect(page.locator(".toast")).toContainText("저장되었습니다");

    const saved = await page.evaluate(() => settings.kpiApprovalStages.map(s => s.weight));
    expect(saved).toEqual([30, 70]);

    // 이제 합계가 100%가 아니게 바꾸면 저장이 차단되고 설정이 그대로 유지돼야 한다.
    await page.click(".tabs button:has-text('평가 단계 설정')");
    const weightInputs2 = page.locator("#settings-content input[type=number][min='0'][max='100']");
    await weightInputs2.nth(1).fill("50"); // 30+50=80 ≠ 100
    await expect(page.locator("#kpi-stage-weight-total")).toHaveText("80%");
    await page.click("#settings-content button:has-text('저장')");
    await expect(page.locator(".toast").last()).toContainText("100%가 되어야");
    const stillSaved = await page.evaluate(() => settings.kpiApprovalStages.map(s => s.weight));
    expect(stillSaved).toEqual([30, 70]); // 변경되지 않음

    expect(pageErrors).toEqual([]);
  });

  test("평가결과 통합 리포트에 종합점수/종합등급 열이 표시된다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await loginAsAdmin(page);

    const DEPT = "종합점수리포트부서_B4";
    await page.evaluate((DEPT) => {
      const YEAR = 2035;
      settings.compEvalYear = YEAR;
      settings.scoreWeights = { kpi: 60, comp: 20, ls: 20 };
      employees.push({
        id: 95501, empNo: "E95501", name: "종합리포트대상", dept: DEPT, team: "A1팀",
        rank: "대리", position: "", active: true, hire: "2019-01-01", hrHistory: [], role: "member",
        gradeResults: { [YEAR]: { score: 80, grade: "A" } },
      });
      compGradeResults[95501] = { [YEAR]: { score: 90, grade: "S", adjustedBy: 1, adjustedByName: "관리자", adjustedAt: "2035-12-01" } };
    }, DEPT);

    await page.evaluate(() => { compSelYear = 2035; compTab = "overview"; gotoPage("comp-eval"); });
    await page.click(".comp-tab-row button:has-text('통합 리포트')");
    await page.selectOption("#comp-content .filter-bar select", DEPT);

    // (80×60+90×40)/100 = 84 → getGrade(84)="A"
    const row = page.locator("#comp-content tbody tr", { hasText: "종합리포트대상" });
    await expect(row).toContainText("84점");
    await expect(page.locator("#comp-content")).toContainText("종합점수 산출 인원");

    await page.evaluate(() => {
      window.__csvCalls = [];
      dlCSV = async (fn, headers, rows) => { window.__csvCalls.push({ fn, headers, rows }); };
    });
    await page.click("button:has-text('📥 리포트 다운로드(CSV)')");
    const calls = await page.evaluate(() => window.__csvCalls);
    const dataRow = calls[0].rows.find(r => r[0] === "종합리포트대상");
    expect(dataRow[9]).toBe("84점"); // 종합점수 컬럼(끝에서 2번째)
    expect(dataRow[10]).toBe("A"); // 종합등급 컬럼(마지막)

    expect(pageErrors).toEqual([]);
  });
});
