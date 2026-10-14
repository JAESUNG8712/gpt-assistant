const { test, expect } = require("@playwright/test");

// 작업5(항목A) — PMS 작업/마일스톤/예산. pms_tasks/pms_milestones/프로젝트
// budgetPlanned는 전용 REST 테이블(employees처럼 /save 전체상태 블롭을 거치지
// 않음)이라, loadFromServer()를 로그인 전에 완전히 막아도 안전하다.
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

test.describe("작업5(항목A) — PMS 프로젝트 상세(작업/마일스톤/예산)", () => {
  test("프로젝트 상세 모달의 작업/마일스톤/예산 3개 탭이 전부 렌더링되고 CRUD가 end-to-end로 동작한다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await loginAsAdmin(page);

    const projName = `e2e-PMS상세-${Date.now()}`;
    await page.evaluate(() => gotoPage("pms-projects"));
    await page.click("button:has-text('+ 프로젝트 등록')");
    await page.fill("#pj-name", projName);
    await page.click(".modal-foot button.btn-primary:has-text('저장')");
    await expect(page.locator(".toast", { hasText: "저장되었습니다" })).toBeVisible();

    // 상세보기 모달 열기 — 기본 pane은 "작업".
    const row = page.locator("#content tbody tr", { hasText: projName });
    await row.locator("button:has-text('🗂 상세보기')").click();
    await expect(page.locator(".modal-head h2", { hasText: projName })).toBeVisible();
    await expect(page.locator("#pms-detail-content")).toContainText("등록된 작업이 없습니다.");

    // ── 작업(tasks) CRUD ──────────────────────────────────────────────
    await page.click("#pms-detail-content button:has-text('+ 작업 추가')");
    await expect(page.locator(".modal-head h2", { hasText: "작업 추가" })).toBeVisible();
    await page.fill("#pmst-title", "요구사항 분석");
    await page.selectOption("#pmst-status", "in_progress");
    await page.selectOption("#pmst-priority", "high");
    await page.fill("#pmst-duedate", "2026-11-30");
    await page.click(".modal-foot button.btn-primary:has-text('저장')");
    await expect(page.locator(".toast", { hasText: "저장되었습니다" })).toBeVisible();
    const taskRow = page.locator("#pms-detail-content tbody tr", { hasText: "요구사항 분석" });
    await expect(taskRow).toContainText("진행중");
    await expect(taskRow).toContainText("높음");
    await expect(taskRow).toContainText("2026-11-30");

    // 수정: 상태를 "완료"로 변경.
    await taskRow.locator("button:has-text('수정')").click();
    await page.selectOption("#pmst-status", "done");
    await page.click(".modal-foot button.btn-primary:has-text('저장')");
    await expect(page.locator("#pms-detail-content tbody tr", { hasText: "요구사항 분석" })).toContainText("완료");

    // 삭제.
    await page.evaluate(() => { askConfirmModal = async () => true; });
    await taskRow.locator("button:has-text('삭제')").click();
    await expect(page.locator(".toast", { hasText: "삭제되었습니다" })).toBeVisible();
    await expect(page.locator("#pms-detail-content")).toContainText("등록된 작업이 없습니다.");

    // ── 마일스톤(milestones) CRUD ─────────────────────────────────────
    await page.click("#pmsd-tab-milestones");
    await expect(page.locator("#pms-detail-content")).toContainText("등록된 마일스톤이 없습니다.");
    await page.click("#pms-detail-content button:has-text('+ 마일스톤 추가')");
    await page.fill("#pmsm-title", "1차 개발 완료");
    await page.fill("#pmsm-duedate", "2026-12-15");
    await page.fill("#pmsm-desc", "MVP 범위 확정");
    await page.click(".modal-foot button.btn-primary:has-text('저장')");
    const msRow = page.locator("#pms-detail-content tbody tr", { hasText: "1차 개발 완료" });
    await expect(msRow).toContainText("2026-12-15");
    await expect(msRow).toContainText("MVP 범위 확정");

    // 수정: 완료 처리.
    await msRow.locator("button:has-text('수정')").click();
    await page.selectOption("#pmsm-status", "done");
    await page.click(".modal-foot button.btn-primary:has-text('저장')");
    await expect(page.locator("#pms-detail-content tbody tr", { hasText: "1차 개발 완료" })).toContainText("완료");

    // 삭제.
    await page.evaluate(() => { askConfirmModal = async () => true; });
    await msRow.locator("button:has-text('삭제')").click();
    await expect(page.locator("#pms-detail-content")).toContainText("등록된 마일스톤이 없습니다.");

    // ── 예산(budget) — 참고용 자동산정 ───────────────────────────────
    await page.click("#pmsd-tab-budget");
    await expect(page.locator("#pms-detail-content")).toContainText("참고용 추정치");
    await expect(page.locator("#pmsb-planned")).toHaveValue("0");
    await expect(page.locator("#pms-detail-content")).toContainText("총 투입 시간: 0시간");

    await page.fill("#pmsb-planned", "5000000");
    await page.click("button:has-text('계획 예산 저장')");
    await expect(page.locator(".toast", { hasText: "저장되었습니다" })).toBeVisible();

    // 모달을 닫고 다시 열어도(서버 재조회) 계획 예산이 유지되는지 확인.
    await page.click(".modal-foot button:has-text('닫기')");
    await page.locator("#content tbody tr", { hasText: projName }).locator("button:has-text('🗂 상세보기')").click();
    await page.click("#pmsd-tab-budget");
    await expect(page.locator("#pmsb-planned")).toHaveValue("5000000");

    expect(pageErrors).toEqual([]);
  });

  test("프로젝트 투입 인원이 아닌 일반 직원은 작업/마일스톤에 추가·수정·삭제 버튼이 보이지 않는다(조회만 가능)", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await loginAsAdmin(page);

    const empId = 9601;
    await page.evaluate((id) => {
      employees.push({
        id, empNo: "E9601", name: "일반직원A", dept: "개발본부", team: "A팀",
        rank: "사원", position: "", active: true, hire: "2022-01-01", hrHistory: [], role: "member",
      });
    }, empId);

    const projName = `e2e-PMS뷰어-${Date.now()}`;
    await page.evaluate(() => gotoPage("pms-projects"));
    await page.click("button:has-text('+ 프로젝트 등록')");
    await page.fill("#pj-name", projName);
    // datalist 옵션은 네이티브 UI라 직접 클릭이 불가능해, 이 모달의 기존
    // _pmjAddMember() 로직(검색창 값에서 "[#id]" 패턴을 추출)과 동일하게 값을
    // 그대로 채워 넣고 "추가" 버튼을 누른다.
    await page.fill("#pj-member-search", `일반직원A (개발본부) [#${empId}]`);
    await page.click(".modal-body button:has-text('추가')");
    await page.click(".modal-foot button.btn-primary:has-text('저장')");
    await expect(page.locator(".toast", { hasText: "저장되었습니다" })).toBeVisible();

    // canManage는 currentUser(클라이언트 변수)가 아니라 GET /api/pms/projects 응답에 서버가
    // 실제 인증 토큰으로 계산해 실어주는 필드(_pmsCanManageProject, server.js)다 — 이 e2e
    // 스위트는 다른 모든 spec과 동일하게 admin 계정으로만 로그인하므로(실제 member 토큰을
    // 발급받지 않음), currentUser만 바꿔 loadPmsFromServer()를 다시 불러도 여전히 admin
    // 토큰으로 조회해 canManage:true를 그대로 받는다(2026-10-14 실측: 이 방식으로는 아래
    // "+ 작업 추가" 버튼이 사라지지 않음). 서버의 권한판정 자체는 이미
    // test/api-pms-tasks-milestones.test.js가 실제 로그인으로 검증하므로, 이 e2e 테스트는
    // "canManage:false를 받았을 때 클라이언트가 관리버튼을 올바르게 숨기는가"라는 순수
    // 렌더링 로직만 검증하도록 그 결과값을 직접 주입한다.
    await page.evaluate((name) => {
      const p = pmsProjects.find((x) => x.name === name);
      if (p) p.canManage = false;
    }, projName);

    const row = page.locator("#content tbody tr", { hasText: projName });
    await expect(row.locator("button:has-text('🗂 상세보기')")).toBeVisible();
    await row.locator("button:has-text('🗂 상세보기')").click();
    await expect(page.locator("#pms-detail-content button:has-text('+ 작업 추가')")).toHaveCount(0);

    await page.click("#pmsd-tab-milestones");
    await expect(page.locator("#pms-detail-content button:has-text('+ 마일스톤 추가')")).toHaveCount(0);

    await page.click("#pmsd-tab-budget");
    await expect(page.locator("#pms-detail-content")).toContainText("참고용 추정치");
    await expect(page.locator("#pmsb-planned")).toHaveCount(0);
    await expect(page.locator("button:has-text('계획 예산 저장')")).toHaveCount(0);

    expect(pageErrors).toEqual([]);
  });
});
