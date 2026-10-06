const { test, expect } = require("@playwright/test");

// OKR 모듈(Epic C — HR마인드 벤치마킹). 목표(Objective)·핵심지표(KR) 등록/승인, 체크인
// 타임라인, 코멘트·첨부파일을 UI 흐름으로 검증한다. 서버측 권한 게이팅은 별도 작성될 수
// 있는 서버 테스트의 몫이고, 이 e2e는 "화면이 역할별로 올바른 범위를 보여주고 생명주기가
// 실제로 동작하는가"에 집중한다(다른 Epic C e2e들과 동일한 분담 원칙).

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

async function seedTeam(page) {
  await page.evaluate(() => {
    settings.evalYear = 2026;
    employees.push(
      { id: 9801, empNo: "E9801", name: "팀원오너", dept: "경영지원본부", team: "인사팀", rank: "사원", position: "", active: true, hire: "2022-01-01", hrHistory: [], role: "member" },
      { id: 9802, empNo: "E9802", name: "담당팀장", dept: "경영지원본부", team: "인사팀", rank: "과장", position: "팀장", active: true, hire: "2018-01-01", hrHistory: [], role: "leader" },
      { id: 9803, empNo: "E9803", name: "무관직원", dept: "영업본부", team: "국내영업팀", rank: "사원", position: "", active: true, hire: "2022-01-01", hrHistory: [], role: "member" },
    );
  });
}

test.describe("OKR 모듈", () => {
  test("작성→제출→승인→체크인 전체 생애주기와 전사 목표 보드 공개가 동작한다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await loginAsAdmin(page);
    await seedTeam(page);

    // 오너(팀원) 입장에서 OKR 작성
    await page.evaluate(() => { currentUser = { ...currentUser, id: 9801, role: "member", dept: "경영지원본부", team: "인사팀", name: "팀원오너" }; });
    await page.evaluate(() => gotoPage("okr"));
    await expect(page.locator("#content")).toContainText("내 목표");

    await page.click("button:has-text('+ 목표 등록')");
    await page.fill("#okr-title", "신규 서비스 안정적 출시");
    await page.selectOption("#okr-scope", "company");
    await page.click("button:has-text('+ 핵심지표 추가')");
    await page.fill(".modal-body input[placeholder='핵심지표명']", "가동률 목표 달성");
    await page.fill(".modal-body input[placeholder='목표치']", "99");
    await page.fill(".modal-body input[placeholder='단위']", "%");
    await page.click(".modal-foot button:has-text('저장')");
    await expect(page.locator(".modal-box, .modal")).toHaveCount(0);
    await expect(page.locator("#okr-content")).toContainText("신규 서비스 안정적 출시");
    await expect(page.locator("#okr-content")).toContainText("작성중");

    // 제출
    await page.click("button:has-text('제출')");
    await expect(page.locator("#okr-content")).toContainText("승인 대기");

    const objId = await page.evaluate(() => okrObjectives.find(o => o.ownerId === 9801).id);

    // 무관한 직원(다른 부서)은 이 draft/pending 목표를 "내 목표"나 "전사 목표 보드"에서 볼 수 없다.
    await page.evaluate(() => { currentUser = { ...currentUser, id: 9803, role: "member", dept: "영업본부", team: "국내영업팀", name: "무관직원" }; });
    await page.evaluate(() => { okrTab = "board"; renderOkrPage(); });
    await expect(page.locator("#okr-content")).not.toContainText("신규 서비스 안정적 출시");

    // 담당 팀장이 "팀 검토" 탭에서 보고 승인
    await page.evaluate(() => { currentUser = { ...currentUser, id: 9802, role: "leader", dept: "경영지원본부", team: "인사팀", name: "담당팀장" }; });
    await page.evaluate(() => { okrTab = "review"; renderOkrPage(); });
    await expect(page.locator("#okr-content")).toContainText("신규 서비스 안정적 출시");

    // approveOkr()은 네이티브 confirm()이 아니라 커스텀 askConfirmModal(DOM 오버레이)을 쓴다 —
    // 카드의 "승인" 버튼을 누르면 모달이 뜨고, 모달 자신의 확인 버튼(confirmText도 "승인")을
    // 다시 눌러야 Promise가 true로 resolve된다(page.on("dialog",...)는 네이티브 전용이라 무동작).
    await page.click("#okr-content button:has-text('승인')");
    await page.click(".modal-foot button:has-text('승인')");
    await expect(page.locator(".modal-box, .modal")).toHaveCount(0); // askConfirmModal 처리 후 재렌더
    const status = await page.evaluate(() => okrObjectives.find(o => o.ownerId === 9801).status);
    expect(status).toBe("approved");

    // 승인 후 "전사 목표 보드"(scope:company)에 무관 직원에게도 노출된다.
    await page.evaluate(() => { currentUser = { ...currentUser, id: 9803, role: "member", dept: "영업본부", team: "국내영업팀", name: "무관직원" }; });
    await page.evaluate(() => { okrTab = "board"; renderOkrPage(); });
    await expect(page.locator("#okr-content")).toContainText("신규 서비스 안정적 출시");
    await expect(page.locator("#okr-content")).toContainText("승인됨");

    // 오너가 핵심지표에 체크인 — 진행률·타임라인 반영 확인
    await page.evaluate((id) => { currentUser = { ...currentUser, id: 9801, role: "member", name: "팀원오너" }; openOkrDetailModal(id); }, objId);
    await expect(page.locator(".modal-body")).toContainText("가동률 목표 달성");
    await page.fill("[id^='okr-checkin-val-']", "95");
    await page.fill("[id^='okr-checkin-note-']", "1분기 진행 순조");
    await page.click(".modal-body button:has-text('체크인')");
    await expect(page.locator(".modal-body")).toContainText("95% / 99%");
    await expect(page.locator(".modal-body")).toContainText("1분기 진행 순조");

    // 코멘트 등록
    await page.fill("#okr-comment-input", "순조롭게 진행 중입니다");
    await page.click(".modal-body button:has-text('등록')");
    await expect(page.locator("#okr-comments")).toContainText("순조롭게 진행 중입니다");

    expect(pageErrors).toEqual([]);
  });

  test("반려 시 사유가 기록되고 소유자 화면에 노출된다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await loginAsAdmin(page);
    await seedTeam(page);

    await page.evaluate(() => {
      okrObjectives.push({
        id: "okr_test_reject", year: 2026, ownerId: 9801, ownerName: "팀원오너", dept: "경영지원본부", team: "인사팀",
        scope: "personal", title: "반려될 목표", description: "", status: "pending", submittedAt: new Date().toISOString(),
        krs: [{ id: "kr_x", title: "지표A", targetValue: 10, currentValue: 0, unit: "건", checkIns: [] }],
        comments: [], attachments: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
    });

    await page.evaluate(() => { currentUser = { ...currentUser, id: 9802, role: "leader", dept: "경영지원본부", team: "인사팀", name: "담당팀장" }; });
    await page.evaluate(() => gotoPage("okr"));
    await page.evaluate(() => { okrTab = "review"; renderOkrPage(); });

    page.once("dialog", d => d.accept("목표가 너무 모호합니다"));
    await page.click("#okr-content button:has-text('반려')");
    const rec = await page.evaluate(() => okrObjectives.find(o => o.id === "okr_test_reject"));
    expect(rec.status).toBe("rejected");
    expect(rec.rejectReason).toBe("목표가 너무 모호합니다");

    await page.evaluate(() => { currentUser = { ...currentUser, id: 9801, role: "member", dept: "경영지원본부", team: "인사팀", name: "팀원오너" }; });
    await page.evaluate(() => { okrTab = "mine"; renderOkrPage(); });
    await expect(page.locator("#okr-content")).toContainText("반려됨");
    await expect(page.locator("#okr-content")).toContainText("목표가 너무 모호합니다");

    expect(pageErrors).toEqual([]);
  });
});
