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

test.describe("평가 중 수시 피드백 교환(kpiEntries.feedbackThread)", () => {
  test("기존 메시지는 채팅 버블로 표시되고, 새 메시지 전송 시 배지 카운트·버블·XSS 이스케이프가 정확하다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));

    await loginAsAdmin(page);

    await page.evaluate(() => {
      settings.evalYear = 2026;
      kpiEntries.push({
        id: 7001, userId: 1, year: 2026, item: "피드백테스트목표", weight: 30,
        firstStatus: "", finalStatus: "",
        // 평가자(leaderA)가 먼저 남긴 메시지 — currentUser(admin, id=1)와 다른 명의라
        // "내 메시지"가 아닌 왼쪽 정렬 버블로 표시돼야 한다.
        feedbackThread: [
          { id: "fb-seed-1", empId: "leaderA", authorName: "팀장A", role: "leader", message: "진행 상황 공유 부탁드립니다.", createdAt: "2026-01-10T09:00:00.000Z" },
        ],
      });
    });

    await page.evaluate(() => gotoPage("kpi"));

    // 사이드바에도 "💬"가 들어간 버튼(예: 알림센터)이 있을 수 있어, 반드시 카드
    // 영역으로 좁혀서 찾는다(그렇지 않으면 다른 요소가 먼저 매칭될 수 있다).
    const feedbackBtn = page.locator("#kpi-cards-area button", { hasText: "💬 피드백" });
    await expect(feedbackBtn).toContainText("💬 피드백 (1)");

    await feedbackBtn.click();
    const thread = page.locator("#kpi-fb-thread");
    await expect(thread).toContainText("팀장A");
    await expect(thread).toContainText("팀장"); // ROLES["leader"] 표기
    await expect(thread).toContainText("진행 상황 공유 부탁드립니다.");

    // 모달 안의 버튼은 반드시 .modal-ov로 좁혀서 찾는다 — 사이드바 등 배경 버튼까지
    // 포함하는 넓은 locator는 모달이 열려있어도 배경 요소를 먼저 매칭해 클릭이
    // 가로막힐 수 있다(실측으로 발견).
    const modal = page.locator(".modal-ov").last();
    // XSS 안전성 확인용 특수문자 포함 메시지
    const payload = "<img src=x onerror=alert(1)>안전한가요?";
    await page.fill("#kpi-fb-input", payload);
    await modal.locator("button", { hasText: "보내기" }).click();

    await expect(thread).toContainText("안전한가요?");
    const html = await thread.innerHTML();
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
    expect(html).toContain("&lt;img");

    // 메시지 전송 직후에도 실행 가능한 스크립트가 주입되지 않았으므로 pageerror가 없어야 한다
    expect(pageErrors).toEqual([]);

    // 입력창은 전송 후 비워진다
    await expect(page.locator("#kpi-fb-input")).toHaveValue("");

    await modal.locator("button", { hasText: "닫기" }).click();
    await page.evaluate(() => renderKPI(false));
    await expect(page.locator("#kpi-cards-area button", { hasText: "💬 피드백" })).toContainText("💬 피드백 (2)");

    expect(pageErrors).toEqual([]);
  });

  test("아직 피드백이 없으면 안내 문구만 표시된다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));

    await loginAsAdmin(page);
    await page.evaluate(() => {
      settings.evalYear = 2026;
      kpiEntries.push({ id: 7002, userId: 1, year: 2026, item: "빈스레드목표", weight: 20, firstStatus: "", finalStatus: "" });
    });
    await page.evaluate(() => gotoPage("kpi"));

    const btn = page.locator("#kpi-cards-area button", { hasText: "💬 피드백" });
    await expect(btn).not.toContainText("(");
    await btn.click();
    await expect(page.locator("#kpi-fb-thread")).toContainText("아직 주고받은 피드백이 없습니다.");

    expect(pageErrors).toEqual([]);
  });

  test("무관한 제3자(canEdit=false)에게는 피드백 버튼 자체가 보이지 않는다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));

    await loginAsAdmin(page);
    await page.evaluate(() => {
      settings.evalYear = 2026;
      employees.push({ id: 9201, empNo: "E9201", name: "무관직원", dept: "영업본부", team: "T9", rank: "사원", position: "", active: true, hire: "2020-01-01", hrHistory: [], role: "member" });
      kpiEntries.push({ id: 7003, userId: 9201, year: 2026, item: "무관목표", weight: 10, firstStatus: "", finalStatus: "" });
      // currentUser를 무관한 다른 member로 바꿔 canEdit=false인 상태를 재현(이 프로젝트
      // e2e 관례 — org-chart-drag.spec.js의 member 뷰 검증과 동일한 방식).
      currentUser = { ...currentUser, id: 9999, role: "member", dept: "개발본부", team: "T1" };
      kpiSelUserId = 9201;
    });
    await page.evaluate(() => renderKPI(false));

    await expect(page.locator(".kpi-card")).toHaveCount(1);
    await expect(page.locator("#kpi-cards-area button", { hasText: "💬 피드백" })).toHaveCount(0);

    expect(pageErrors).toEqual([]);
  });

  test("직원은 피드백을 기한 있는 실행 약속으로 전환하고 완료 상태를 추적한다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await loginAsAdmin(page);
    await page.evaluate(() => {
      settings.evalYear = 2026;
      employees.push({ id: 9202, empNo: "E9202", name: "실행직원", dept: "개발본부", team: "T1", rank: "사원", active: true, hire: "2024-01-01", hrHistory: [], role: "member", menuPerms: {} });
      currentUser = { ...currentUser, id: 9202, name: "실행직원", role: "member", dept: "개발본부", team: "T1" };
      kpiEntries.push({ id: 7004, userId: 9202, year: 2026, item: "고객 응답 개선", weight: 25, firstStatus: "", finalStatus: "", feedbackThread: [] });
      gotoPage("kpi");
    });

    await page.locator("#kpi-cards-area button", { hasText: "💬 피드백" }).click();
    await page.selectOption("#kpi-fb-kind", "action");
    await expect(page.locator("#kpi-fb-due-wrap")).toBeVisible();
    await page.fill("#kpi-fb-due", "2026-12-15");
    await page.fill("#kpi-fb-input", "고객 문의 24시간 내 회신율을 주간 점검하겠습니다.");
    await page.locator(".modal-ov").last().getByRole("button", { name: "보내기" }).click();

    const thread = page.locator("#kpi-fb-thread");
    await expect(thread).toContainText("실행 약속");
    await expect(thread).toContainText("기한 2026-12-15");
    await thread.getByRole("button", { name: "완료 처리" }).click();
    await page.locator(".modal-ov").last().getByRole("button", { name: "완료 처리" }).click();
    await expect(thread).toContainText("✓ 완료");
    await expect(thread).toContainText("완료 기록");

    await page.locator(".modal-ov").last().getByRole("button", { name: "닫기" }).click();
    await page.evaluate(() => renderEvalProgressPage());
    await expect(page.locator("#content")).toContainText("피드백 실행 약속");
    await expect(page.locator("#content")).toContainText("완료 1건");
    await expect(page.locator("#content")).toContainText("고객 문의 24시간 내 회신율을 주간 점검하겠습니다.");
    expect(pageErrors).toEqual([]);
  });
});
