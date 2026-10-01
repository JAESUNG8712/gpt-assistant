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

// Epic B #1/#5/#7(2026-10): KPI N단계 평가. 서버 측 권한 강제(canFirst/canAct/canFinal,
// 순서 강제, 마감, 조정기간)는 test/api-kpi-n-stage.test.js가 이미 전수 검증했으므로, 이
// e2e는 "화면이 올바르게 렌더링되고 올바른 클라이언트 함수를 호출하는가"만 확인한다 —
// admin으로 로그인한 뒤 currentUser를 교체해 역할별 뷰를 재현하는 이 프로젝트의 기존
// 관례(evaluator-reassignment.spec.js 등과 동일)를 그대로 따른다.
test.describe("Epic B #1/#5/#7 — KPI N단계 평가(관리자 설정·중간단계 승인·재오픈)", () => {
  test("관리자 설정 화면에서 평가 단계를 추가하고 승인자를 지정·저장할 수 있다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await loginAsAdmin(page);

    await page.evaluate(() => {
      employees.push({ id: 9601, empNo: "E9601", name: "인사팀검토자", dept: "경영지원본부", team: "", rank: "", position: "", active: true, hire: "2020-01-01", hrHistory: [], role: "member" });
    });

    await page.evaluate(() => gotoPage("eval-ops"));
    await page.click(".tabs button:has-text('평가 단계 설정')");
    await expect(page.locator("#settings-content")).toContainText("1단계(1차)");
    await expect(page.locator("#settings-content")).toContainText("2단계(최종)");

    await page.click("button:has-text('+ 중간 단계 추가')");
    // 새로 추가된 중간 단계는 기본 "특정 직원 지정"이라 승인자 선택 버튼이 노출된다.
    await expect(page.locator("#settings-content")).toContainText("3단계");
    await page.click("button:has-text('승인자 선택')");
    await expect(page.locator(".modal-head h3")).toContainText("단계 승인자 선택");
    await page.fill("#op-search", "인사팀검토자");
    await page.click("#op-tree input[type=radio]");
    await page.click("button:has-text('선택 완료')");
    await expect(page.locator("#settings-content")).toContainText("인사팀검토자 변경");

    await page.locator("#settings-content input[type=date]").first().fill("2026-12-31");
    // 헤더의 전역 "💾 저장" 버튼도 "저장"을 부분 포함해 매칭되므로 #settings-content로 범위를 좁힌다.
    await page.click("#settings-content button:has-text('저장')");
    await expect(page.locator(".toast")).toContainText("저장되었습니다");

    const stages = await page.evaluate(() => settings.kpiApprovalStages);
    expect(stages.length).toBe(3);
    expect(stages[1].kind).toBe("specific_employee");
    expect(stages[1].approverEmpId).toBe(9601);
    const deadline = await page.evaluate(() => settings.kpiApprovalDeadline);
    expect(deadline).toBe("2026-12-31");

    expect(pageErrors).toEqual([]);
  });

  test("중간 단계 승인 탭 — role:member인 specific_employee 승인자도 메뉴로 진입해 승인할 수 있다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await loginAsAdmin(page);

    await page.evaluate(() => {
      settings.kpiApprovalStages = [
        { id: "s1", label: "1차(팀장)", kind: "team_leader" },
        { id: "sHr", label: "인사팀 검토", kind: "specific_employee", approverEmpId: 9602 },
        { id: "sFinal", label: "최종(사업부장)", kind: "dept_director" },
      ];
      employees.push(
        { id: 9602, empNo: "E9602", name: "인사검토자", dept: "경영지원본부", team: "", rank: "", position: "", active: true, hire: "2020-01-01", hrHistory: [], role: "member" },
        { id: 9603, empNo: "E9603", name: "평가대상자", dept: "개발본부", team: "A팀", rank: "", position: "", active: true, hire: "2021-01-01", hrHistory: [], role: "member" },
      );
      kpiEntries.push(
        { id: 9701, userId: 9603, year: settings.evalYear, item: "목표X", weight: 100, goalSub: true, firstStatus: "approved", firstScore: 90, updatedAt: new Date().toISOString() },
        // 아직 1차 미승인 — 중간단계 큐에 나타나면 안 된다(순서 강제).
        { id: 9702, userId: 9603, year: settings.evalYear, item: "목표Y", weight: 100, goalSub: true, firstStatus: "", updatedAt: new Date().toISOString() },
      );
    });

    // role:member인 지정 승인자로 전환해, role로 막힌 first-eval/second-eval이 아니라
    // 새 전용 페이지(kpi-midstage, PAGE_ROLES 미등록 — 전 역할 개방)로 실제 진입한다.
    await page.evaluate(() => { currentUser = { ...currentUser, id: 9602, role: "member", dept: "경영지원본부", team: "" }; });
    await page.evaluate(() => gotoPage("kpi-midstage"));
    await expect(page.locator(".tab-btn", { hasText: "중간 단계 승인" })).toBeVisible();
    const rows = page.locator("#approval-content tbody tr");
    await expect(rows).toHaveCount(1); // 목표X만(목표Y는 1차 미승인이라 제외)
    await expect(page.locator("#approval-content")).toContainText("평가대상자");
    await expect(page.locator("#approval-content")).toContainText("인사팀 검토");

    await page.fill("#ms-score-9701-1", "88");
    await page.fill("#ms-comment-9701-1", "확인 완료");
    // 탭 버튼 "중간 단계 승인"도 "승인"을 부분 포함해 매칭되므로 #approval-content로 범위를 좁힌다.
    await page.click("#approval-content button:has-text('승인')");
    await expect(page.locator("#approval-content")).toContainText("처리할 중간 단계 승인 건이 없습니다");

    const kpi = await page.evaluate(() => kpiEntries.find(k => k.id === 9701));
    expect(kpi.middleStages.sHr.status).toBe("approved");
    expect(kpi.middleStages.sHr.score).toBe(88);
    expect(kpi.middleStages.sHr.comment).toBe("확인 완료");

    expect(pageErrors).toEqual([]);
  });

  test("조정기간 중 재오픈 버튼 — 사업부장이 최종확정된 KPI를 되돌릴 수 있다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await loginAsAdmin(page);

    await page.evaluate(() => {
      settings.kpiAdjustmentPeriod = { open: true, start: "2026-01-01", end: "2026-12-31", note: "e2e" };
      employees.push(
        { id: 9611, empNo: "E9611", name: "사업부장재오픈", dept: "개발본부", team: "", rank: "", position: "", active: true, hire: "2015-01-01", hrHistory: [], role: "director" },
        { id: 9612, empNo: "E9612", name: "확정대상자", dept: "개발본부", team: "A팀", rank: "", position: "", active: true, hire: "2021-01-01", hrHistory: [], role: "member" },
      );
      kpiEntries.push({ id: 9801, userId: 9612, year: settings.evalYear, item: "목표Z", weight: 100, goalSub: true, firstStatus: "approved", firstScore: 80, finalStatus: "approved", finalConfirmed: true, finalScore: 90, secondScore: 90, updatedAt: new Date().toISOString() });
    });

    await page.evaluate(() => {
      currentUser = { ...currentUser, id: 9611, role: "director", dept: "개발본부", team: "" };
      approvalTab = "list"; approvalSearch = { name: "", dept: "" };
    });
    await page.evaluate(() => gotoPage("second-eval"));
    // second-eval 진입점은 approvalTab을 "eval"로 강제하므로, 명시적으로 list 탭으로 이동한다.
    await page.click(".tab-btn:has-text('KPI 승인 현황')");

    await expect(page.locator("#appr-list-content")).toContainText("확정대상자");
    await page.click("button:has-text('🔓 재오픈')");
    await expect(page.locator(".modal-head h2")).toContainText("최종확정 재오픈");
    await page.click(".modal-foot button.btn-danger");

    const kpi = await page.evaluate(() => kpiEntries.find(k => k.id === 9801));
    expect(kpi.finalStatus).toBe("");
    expect(kpi.finalConfirmed).toBe(false);
    expect(kpi.finalScore).toBe(90); // 과거 점수는 감사를 위해 보존

    expect(pageErrors).toEqual([]);
  });
});
