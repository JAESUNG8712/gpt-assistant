const { test, expect } = require("@playwright/test");

// D3(HR마인드 벤치마킹 2차 라운드) — 교육관리 고도화. mandatoryTraining(법정의무교육 완료로그)와는
// 완전히 별개의 과정 카탈로그(개설·정원 기반 신청/대기·이수·설문·비용정산) 워크플로우를 검증한다.
// 서버측 쓰기는 신규 검증 없이 다른 employees 필드와 동일한 admin 전체신뢰 모델을 그대로
// 따르므로(이 모듈은 전용 ID_KEYED_LIST_FIELDS일 뿐 role 전용 서버 검증이 추가되지 않음),
// 이 e2e는 화면 흐름(정원 초과 시 대기, 관리자 승인/승급/완료 처리, 설문, 알림, CSV)에 집중한다.

async function loginAsAdmin(page) {
  await page.goto("/");
  await page.fill("#l-id", "e2e_admin");
  await page.fill("#l-pw", "E2eTestPw123");
  await page.evaluate(() => {
    autoSaveDebounced = () => {};
    loadFromServer = async () => {};
    connectSSE = async () => {};
  });
  await page.click(".login-card button.btn-primary");
  await expect(page.locator("#main")).toBeVisible({ timeout: 10000 });
}

test.describe("D3 — 교육 과정 관리", () => {
  test("정원이 가득 차면 이후 신청자는 대기 신청이 되고, 관리자가 승급/완료 처리할 수 있다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await loginAsAdmin(page);

    await page.evaluate(() => {
      employees.push(
        { id: 98301, empNo: "E98301", name: "교육신청1", dept: "경영지원본부", team: "인사팀", rank: "사원", position: "", active: true, hire: "2022-01-01", hrHistory: [], role: "member" },
        { id: 98302, empNo: "E98302", name: "교육신청2", dept: "경영지원본부", team: "인사팀", rank: "사원", position: "", active: true, hire: "2022-01-01", hrHistory: [], role: "member" },
      );
    });

    // 관리자가 정원 1명짜리 과정을 개설한다.
    await page.evaluate(() => gotoPage("training-admin"));
    await page.click("button:has-text('＋ 과정 개설')");
    await page.fill("#tc-title", "D3 테스트 과정");
    await page.selectOption("#tc-category", "리더십");
    await page.selectOption("#tc-status", "open");
    await page.fill("#tc-start", "2026-11-01");
    await page.fill("#tc-end", "2026-11-01");
    await page.fill("#tc-capacity", "1");
    await page.fill("#tc-cost", "300000");
    await page.click(".modal-foot button:has-text('저장')");
    await expect(page.locator(".modal-box, .modal")).toHaveCount(0);
    await expect(page.locator("#content")).toContainText("D3 테스트 과정");

    const courseId = await page.evaluate(() => trainingCourses.find((c) => c.title === "D3 테스트 과정").id);

    // 직원1이 신청 → 정원 안이므로 "applied"
    await page.evaluate(() => { currentUser = { ...currentUser, id: 98301, name: "교육신청1", role: "member", dept: "경영지원본부", team: "인사팀" }; });
    await page.evaluate(() => gotoPage("training-courses"));
    await page.click("button:has-text('신청하기')");
    await expect(page.locator("#content")).toContainText("신청완료");

    // 직원2가 신청 → 정원이 꽉 찼으므로 "대기 신청"
    await page.evaluate(() => { currentUser = { ...currentUser, id: 98302, name: "교육신청2", role: "member", dept: "경영지원본부", team: "인사팀" }; });
    await page.evaluate(() => gotoPage("training-courses"));
    await expect(page.locator("#content")).toContainText("대기 신청");
    await page.click("button:has-text('대기 신청')");
    await expect(page.locator("#content")).toContainText("대기중");

    const statuses1 = await page.evaluate(() => trainingEnrollments.filter((e) => String(e.empId) === "98301" || String(e.empId) === "98302").map((e) => ({ empId: e.empId, status: e.status })));
    expect(statuses1.find((s) => String(s.empId) === "98301").status).toBe("applied");
    expect(statuses1.find((s) => String(s.empId) === "98302").status).toBe("waitlisted");

    // 관리자가 신청자 관리에서 직원1을 완료 처리하고, 직원2를 대기→신청으로 승급한다.
    await page.evaluate(() => { currentUser = { ...currentUser, id: 1, name: "e2e_admin", role: "admin" }; });
    await page.evaluate((cid) => { openTcRosterModal(cid); }, courseId);
    await expect(page.locator("#tc-roster-body")).toContainText("교육신청1");
    await expect(page.locator("#tc-roster-body")).toContainText("교육신청2");

    // 직원2(대기중)를 승급
    await page.click("#tc-roster-body tr:has-text('교육신청2') button:has-text('대기→신청')");
    await expect(page.locator("#tc-roster-body tr", { hasText: "교육신청2" })).toContainText("신청완료");

    // 직원1(신청완료)만 체크박스로 선택해 "선택 완료 처리"
    await page.locator("#tc-roster-body tr", { hasText: "교육신청1" }).locator("input.tc-roster-chk").check();
    await page.click("#tc-roster-body button:has-text('선택 완료 처리')");
    await expect(page.locator("#tc-roster-body tr", { hasText: "교육신청1" })).toContainText("이수완료");
    // 직원2는 체크하지 않았으므로 여전히 "신청완료" 상태를 유지해야 한다(과잉 완료처리 방지).
    await expect(page.locator("#tc-roster-body tr", { hasText: "교육신청2" })).toContainText("신청완료");

    const final = await page.evaluate(() => trainingEnrollments.filter((e) => String(e.empId) === "98301" || String(e.empId) === "98302").map((e) => ({ empId: e.empId, status: e.status })));
    expect(final.find((s) => String(s.empId) === "98301").status).toBe("completed");
    expect(final.find((s) => String(s.empId) === "98302").status).toBe("applied");

    expect(pageErrors).toEqual([]);
  });

  test("이수 완료 후 만족도 설문을 제출하면 알림센터 안내가 사라지고 관리자 화면에 점수가 반영된다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await loginAsAdmin(page);

    await page.evaluate(() => {
      employees.push({ id: 98303, empNo: "E98303", name: "설문직원D3", dept: "경영지원본부", team: "인사팀", rank: "사원", position: "", active: true, hire: "2022-01-01", hrHistory: [], role: "member" });
      trainingCourses.push({ id: "tcrs-d3test", title: "설문 테스트 과정", category: "직무역량", status: "completed", startDate: "2026-09-01", endDate: "2026-09-02", capacity: null, cost: 100000, surveyEnabled: true, description: "", createdBy: 1, createdByName: "admin", createdAt: new Date().toISOString() });
      const now = new Date().toISOString();
      trainingEnrollments.push({ id: "tenr-d3test", courseId: "tcrs-d3test", empId: 98303, empName: "설문직원D3", dept: "경영지원본부", team: "인사팀", appliedAt: now, status: "completed", completedAt: "2026-09-02", surveyResponse: null, note: "", createdAt: now, updatedAt: now });
    });

    // 알림센터에 설문 미제출 안내가 보여야 한다(본인 알림).
    await page.evaluate(() => { currentUser = { ...currentUser, id: 98303, name: "설문직원D3", role: "member", dept: "경영지원본부", team: "인사팀" }; });
    await page.evaluate(() => gotoPage("notification-center"));
    await expect(page.locator("#content")).toContainText("설문 미제출");
    await expect(page.locator("#content")).toContainText("설문 테스트 과정");

    // 내 신청 내역 탭에서 설문을 작성한다.
    await page.evaluate(() => gotoPage("training-courses"));
    await page.click("button:has-text('내 신청 내역')");
    await page.click("button:has-text('설문 작성')");
    await page.selectOption("#tcs-sat", "5");
    await page.fill("#tcs-comment", "매우 유익했습니다.");
    await page.click(".modal-foot button:has-text('제출')");
    await expect(page.locator(".modal-box, .modal")).toHaveCount(0);
    await expect(page.locator("#content")).toContainText("만족도 5/5");

    // 알림센터에서 안내가 사라진다.
    await page.evaluate(() => gotoPage("notification-center"));
    await expect(page.locator("#content")).not.toContainText("설문 미제출");

    // 관리자 신청자 관리 화면에서도 설문 점수가 보인다.
    await page.evaluate(() => { currentUser = { ...currentUser, id: 1, name: "e2e_admin", role: "admin" }; });
    await page.evaluate(() => { openTcRosterModal("tcrs-d3test"); });
    await expect(page.locator("#tc-roster-body")).toContainText("5/5");

    expect(pageErrors).toEqual([]);
  });

  test("과정별 비용·신청/이수 현황을 CSV로 내보내고, 코드관리 허브에 과정 개수가 반영된다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await loginAsAdmin(page);

    await page.evaluate(() => {
      trainingCourses.push(
        { id: "tcrs-d3cost1", title: "비용집계과정A", category: "IT/디지털", status: "completed", startDate: "2026-08-01", endDate: "2026-08-02", capacity: 10, cost: 500000, surveyEnabled: false, description: "", createdBy: 1, createdByName: "admin", createdAt: new Date().toISOString() },
        { id: "tcrs-d3cost2", title: "비용집계과정B(취소됨)", category: "어학", status: "canceled", startDate: "2026-08-10", endDate: "2026-08-11", capacity: 5, cost: 1000000, surveyEnabled: false, description: "", createdBy: 1, createdByName: "admin", createdAt: new Date().toISOString() },
      );
    });

    const countBefore = await page.evaluate(() => trainingCourses.length);

    // 다른 리포트 다운로드 테스트들(eval-report.spec.js 등)과 동일한 관례대로, 실제 브라우저
    // 다운로드 이벤트 대신 dlCSV() 호출 자체를 가로채 파일명·헤더·행 내용을 직접 검증한다.
    await page.evaluate(() => {
      window.__csvCalls = [];
      dlCSV = async (fn, headers, rows) => { window.__csvCalls.push({ fn, headers, rows }); };
    });
    await page.evaluate(() => gotoPage("training-admin"));
    await page.click("button:has-text('📥 비용·결과 다운로드')");

    const calls = await page.evaluate(() => window.__csvCalls);
    expect(calls.length).toBe(1);
    expect(calls[0].fn).toMatch(/^교육과정_비용결과_.*\.csv$/);
    const rowA = calls[0].rows.find((r) => r[0] === "비용집계과정A");
    const rowB = calls[0].rows.find((r) => r[0] === "비용집계과정B(취소됨)");
    expect(rowA[6]).toBe("종료");
    expect(rowA[10]).toBe(500000);
    expect(rowB[6]).toBe("취소");
    expect(rowB[10]).toBe(1000000);

    // 코드관리 허브의 "교육 과정" 카운트가 전체 과정 수(취소 포함)를 그대로 반영한다.
    await page.evaluate(() => gotoPage("code-mgmt"));
    await expect(page.locator("#content")).toContainText("교육 과정");
    await expect(page.locator("#content")).toContainText(`${countBefore}`);

    expect(pageErrors).toEqual([]);
  });
});
