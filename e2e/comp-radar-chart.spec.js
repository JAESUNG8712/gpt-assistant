const { test, expect } = require("@playwright/test");

// 평가결과 리포트 레이더차트(Epic C — HR마인드 벤치마킹). 다면평가 상세(openCompDetailModal)의
// "회사 평균 비교"가 축(카테고리)이 3개 이상이면 기존 막대그래프 대신 방사형(레이더) SVG
// 차트로 바뀐다 — COMP_FORM_ITEMS는 가치역량/업무역량/리더십역량 3개 카테고리를 가지므로
// type:"comp" 세션이면 항상 레이더차트 경로를 탄다.

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

test.describe("평가결과 리포트 레이더차트", () => {
  test("카테고리 3개 이상인 역량평가 상세는 막대그래프 대신 레이더(방사형) SVG 차트를 보여준다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await loginAsAdmin(page);

    await page.evaluate(() => {
      settings.compEvalYear = 2026;
      employees.push(
        { id: 9701, empNo: "E9701", name: "대상자", dept: "경영지원본부", team: "인사팀", rank: "사원", position: "", active: true, hire: "2022-01-01", hrHistory: [], role: "member" },
        { id: 9702, empNo: "E9702", name: "평가자1", dept: "경영지원본부", team: "인사팀", rank: "과장", position: "팀장", active: true, hire: "2018-01-01", hrHistory: [], role: "leader" },
        { id: 9703, empNo: "E9703", name: "비교대상자", dept: "영업본부", team: "국내영업팀", rank: "사원", position: "", active: true, hire: "2022-01-01", hrHistory: [], role: "member" },
        { id: 9704, empNo: "E9704", name: "비교평가자", dept: "영업본부", team: "국내영업팀", rank: "과장", position: "팀장", active: true, hire: "2018-01-01", hrHistory: [], role: "leader" },
      );
      // 대상 세션: 가치역량(v1,v2,v3)·업무역량(b1~b6)·리더십역량(l1~l6) 응답을 4점대로 채움.
      const fullAnswers = (val) => {
        const ans = {};
        ["v1","v2","v3","b1","b2","b3","b4","b5","b6","l1","l2","l3","l4","l5","l6"].forEach(k => ans[k] = val);
        return ans;
      };
      compSessions.push({ id: 97001, year: 2026, targetId: 9701, type: "comp", evaluatorIds: [9702], status: "open", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      compResponses.push({ id: 97101, sessionId: 97001, targetId: 9701, evaluatorId: 9702, year: 2026, type: "comp", answers: fullAnswers(5), submittedAt: new Date().toISOString() });
      // 회사 평균용 비교 세션(같은 연도·유형, 다른 세션) — 더 낮은 점수로 채워 레이더차트에
      // 두 번째(회사 평균) 폴리곤이 생기도록 한다. compResponses에 year/type이 실제 제출
      // 경로(submitCompResponse)와 동일하게 반드시 있어야 _compBenchmarkRows()의 "다른 세션"
      // 필터(r.year===session.year&&r.type===session.type)가 매치된다.
      compSessions.push({ id: 97002, year: 2026, targetId: 9703, type: "comp", evaluatorIds: [9704], status: "open", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      compResponses.push({ id: 97102, sessionId: 97002, targetId: 9703, evaluatorId: 9704, year: 2026, type: "comp", answers: fullAnswers(3), submittedAt: new Date().toISOString() });
    });

    await page.evaluate(() => openCompDetailModal(97001));
    await expect(page.locator(".modal-body svg")).toHaveCount(1);
    // polygon이 최소 3개(링 2개 이상 + 대상자·회사평균 폴리곤 2개) 있어야 레이더차트가 실제로 그려진 것.
    const polyCount = await page.locator(".modal-body svg polygon").count();
    expect(polyCount).toBeGreaterThanOrEqual(5);
    await expect(page.locator(".modal-body")).toContainText("대상자");
    await expect(page.locator(".modal-body")).toContainText("회사 평균");
    // 카테고리 3개 이상이므로 기존 막대그래프(role=img)는 더 이상 렌더링되지 않는다.
    await expect(page.locator('.modal-body [role="img"]')).toHaveCount(0);
    // 축 레이블(카테고리명) 텍스트가 SVG 안에 포함된다.
    await expect(page.locator(".modal-body svg")).toContainText("가치역량");
    await expect(page.locator(".modal-body svg")).toContainText("업무역량");
    await expect(page.locator(".modal-body svg")).toContainText("리더십역량");

    expect(pageErrors).toEqual([]);
  });

  test("비교 데이터(회사 평균)가 아예 없으면 레이더차트 대신 안내 문구를 보여준다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await loginAsAdmin(page);

    await page.evaluate(() => {
      settings.compEvalYear = 2027; // 비교 대상 세션이 전혀 없는 새 연도
      employees.push(
        { id: 9711, empNo: "E9711", name: "단독대상자", dept: "경영지원본부", team: "인사팀", rank: "사원", position: "", active: true, hire: "2022-01-01", hrHistory: [], role: "member" },
        { id: 9712, empNo: "E9712", name: "단독평가자", dept: "경영지원본부", team: "인사팀", rank: "과장", position: "팀장", active: true, hire: "2018-01-01", hrHistory: [], role: "leader" },
      );
      compSessions.push({ id: 97201, year: 2027, targetId: 9711, type: "comp", evaluatorIds: [9712], status: "open", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      compResponses.push({ id: 97301, sessionId: 97201, evaluatorId: 9712, answers: { v1: 4 }, submittedAt: new Date().toISOString() });
    });

    await page.evaluate(() => openCompDetailModal(97201));
    await expect(page.locator(".modal-body")).toContainText("동일 연도·유형의 다른 평가 결과가 없어");
    await expect(page.locator(".modal-body svg")).toHaveCount(0);

    expect(pageErrors).toEqual([]);
  });
});
