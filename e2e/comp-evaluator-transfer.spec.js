const { test, expect } = require("@playwright/test");

// 부서이동 평가자 자동전환(Epic C — HR마인드 벤치마킹, _autoTransitionCompEvaluators).
// 아직 응답이 없고 고정 평가자 지정도 없는 세션은 saveEmpEdit()/_applyDueHRChanges() 등
// 실제 부서·팀 변경 경로를 거치면 evaluatorIds가 새 부서 기준으로 조용히 재계산되고,
// 이미 응답이 있거나 고정 평가자가 지정된 세션은 evaluatorIds를 그대로 두고
// transferFlagged로만 표시되어 새 부서의 관리자가 "하위조직원 평가자 조정" 탭에서
// 직접 확인하도록 한다. 기본 시드 조직(경영지원본부/인사팀, 영업본부/국내영업팀)을
// 그대로 사용해 orgDB를 건드리지 않는다.

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

test.describe("부서이동 평가자 자동전환", () => {
  test("진행 전(응답 없음, 고정 평가자 없음) 세션은 saveEmpEdit()로 부서이동 시 평가자가 새 부서 기준으로 자동 교체된다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await loginAsAdmin(page);

    await page.evaluate(() => {
      settings.compEvalYear = 2026;
      employees.push(
        { id: 9601, empNo: "E9601", name: "인사팀장", dept: "경영지원본부", team: "인사팀", rank: "과장", position: "팀장", active: true, hire: "2018-01-01", hrHistory: [], role: "leader" },
        { id: 9602, empNo: "E9602", name: "인사팀원동료", dept: "경영지원본부", team: "인사팀", rank: "사원", position: "", active: true, hire: "2021-01-01", hrHistory: [], role: "member" },
        { id: 9603, empNo: "E9603", name: "국내영업팀장", dept: "영업본부", team: "국내영업팀", rank: "과장", position: "팀장", active: true, hire: "2018-01-01", hrHistory: [], role: "leader" },
        { id: 9604, empNo: "E9604", name: "국내영업팀원동료", dept: "영업본부", team: "국내영업팀", rank: "사원", position: "", active: true, hire: "2021-01-01", hrHistory: [], role: "member" },
        { id: 9605, empNo: "E9605", name: "이동대상자", dept: "경영지원본부", team: "인사팀", rank: "사원", position: "", active: true, hire: "2022-01-01", hrHistory: [], role: "member", birth: "1995-01-01", gender: "남", nationality: "내국인", jobGroup: "", edu: "" },
      );
      const session = createCompSession(9605, 2026);
      window._beforeIds = [...session.evaluatorIds].sort();
    });

    const beforeIds = await page.evaluate(() => window._beforeIds);
    expect(beforeIds).toEqual([9601, 9602].sort());

    await page.evaluate(() => openEmpEdit(9605));
    await expect(page.locator("#ee-dept")).toBeVisible();
    await page.selectOption("#ee-dept", { label: "영업본부" });
    await page.selectOption("#ee-team", { label: "국내영업팀" });
    await page.click(".modal-foot button.btn-primary:has-text('저장')");
    await expect(page.locator(".modal-box, .modal")).toHaveCount(0);

    const after = await page.evaluate(() => {
      const s = compSessions.find(s => s.targetId === 9605 && s.year === 2026);
      return { evaluatorIds: [...s.evaluatorIds].sort(), transferFlagged: !!s.transferFlagged };
    });
    expect(after.evaluatorIds).toEqual([9603, 9604].sort());
    expect(after.transferFlagged).toBe(false);

    expect(pageErrors).toEqual([]);
  });

  test("이미 응답이 제출된 세션은 evaluatorIds를 바꾸지 않고 transferFlagged로만 표시된다 — 새 부서 관리자 화면에 노출", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await loginAsAdmin(page);

    await page.evaluate(() => {
      settings.compEvalYear = 2026;
      employees.push(
        { id: 9611, empNo: "E9611", name: "인사팀장2", dept: "경영지원본부", team: "인사팀", rank: "과장", position: "팀장", active: true, hire: "2018-01-01", hrHistory: [], role: "leader" },
        { id: 9612, empNo: "E9612", name: "국내영업팀장2", dept: "영업본부", team: "국내영업팀", rank: "과장", position: "팀장", active: true, hire: "2018-01-01", hrHistory: [], role: "leader", menuPerms: {} },
        {
          id: 9613, empNo: "E9613", name: "이동대상자2", dept: "경영지원본부", team: "인사팀", rank: "사원", position: "", active: true, hire: "2022-01-01",
          hrHistory: [{ id: "h-transfer-9613", type: "transfer", date: "2020-01-01", desc: "예정 인사발령", before: "경영지원본부/인사팀", after: "영업본부/국내영업팀", applied: false, pendingUpdates: { dept: "영업본부", team: "국내영업팀" } }],
          role: "member",
        },
      );
      compSessions.push({ id: 86001, year: 2026, targetId: 9613, type: "comp", evaluatorIds: [9611], status: "open", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      compResponses.push({ id: 87001, sessionId: 86001, evaluatorId: 9611, answers: { v1: 5 }, submittedAt: new Date().toISOString() });
      // hrHistory.date(2020-01-01)가 이미 지났으므로 _applyDueHRChanges()가 즉시 적용 대상으로 집는다.
      _applyDueHRChanges();
    });

    const after = await page.evaluate(() => {
      const e = employees.find(e => e.id === 9613);
      const s = compSessions.find(s => s.targetId === 9613 && s.year === 2026);
      return { dept: e.dept, team: e.team, evaluatorIds: [...s.evaluatorIds], transferFlagged: !!s.transferFlagged, transferNote: s.transferNote };
    });
    expect(after.dept).toBe("영업본부");
    expect(after.team).toBe("국내영업팀");
    expect(after.evaluatorIds).toEqual([9611]); // 응답이 이미 있어 교체되지 않음
    expect(after.transferFlagged).toBe(true);
    expect(after.transferNote).toContain("경영지원본부");

    // 새 부서(영업본부)의 팀장이 "하위조직원 평가자 조정" 탭에서 경고 배지를 본다.
    await page.evaluate(() => {
      currentUser = { ...currentUser, id: 9612, role: "leader", dept: "영업본부", team: "국내영업팀" };
    });
    await page.evaluate(() => gotoPage("comp-eval"));
    await page.click(".comp-tab-row button:has-text('하위조직원 평가자 조정')");
    await expect(page.locator("#comp-content")).toContainText("부서이동 — 평가자 확인 필요");
    await expect(page.locator("#comp-content")).toContainText("이동대상자2");

    expect(pageErrors).toEqual([]);
  });
});
