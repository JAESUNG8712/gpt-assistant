const { test, expect } = require("@playwright/test");

async function loginAsAdmin(page) {
  await page.goto("/");
  await page.fill("#l-id", "e2e_admin");
  await page.fill("#l-pw", "E2eTestPw123");
  // 로그인 직후 백그라운드 서버 재동기화(SSE/자동로드)가 테스트가 시딩한
  // 순수 인메모리 상태를 덮어쓰는 경합을 막는다(이 프로젝트의 확립된 관례).
  await page.evaluate(() => {
    loadFromServer = async () => {};
    connectSSE = async () => {};
  });
  await page.click(".login-card button.btn-primary");
  await expect(page.locator("#main")).toBeVisible({ timeout: 10000 });
}

test.describe("역량평가 항목 편집 실제 영속 + 업종별 카테고리 반영(hrmind 참고자료 대응)", () => {
  test("평가 항목 저장이 settings.compEvalItems/leadershipEvalItems로 실제 서버에 영속된다(과거엔 COMP_FORM_ITEMS 배열만 바뀌고 저장되지 않던 침묵 데이터유실 버그)", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await loginAsAdmin(page);

    const saved = await page.evaluate(async () => {
      gotoPage("eval-ops");
      _evalOpsTab = "comp-settings";
      renderEvalOpsPage();
      // 새 카테고리(안전및규정준수) 문항 추가 — 과거엔 select가 3개 고정 옵션뿐이라 불가능했다.
      _compItemsStage = JSON.parse(JSON.stringify(compEvalItems()));
      _compItemsStage.push({ id: "custom-safety-1", cat: "안전및규정준수", title: "안전수칙", q: "테스트 안전 문항" });
      _compItemsLsStage = JSON.parse(JSON.stringify(lsEvalItems()));
      saveCompItems();
      await _doSave(true); // autoSaveDebounced의 디바운스를 기다리지 않고 즉시 실제 서버 저장
      const r = await serverRequest("GET", "/data");
      const items = r.data?.settings?.compEvalItems || [];
      return {
        hasCustom: items.some((i) => i.id === "custom-safety-1" && i.cat === "안전및규정준수"),
        count: items.length,
        getterMatchesSettings: compEvalItems() === settings.compEvalItems,
      };
    });
    expect(saved.hasCustom).toBe(true);
    expect(saved.count).toBeGreaterThan(0);
    expect(saved.getterMatchesSettings).toBe(true);
    expect(pageErrors).toEqual([]);
  });

  test("업종별 평가요소 프리셋(성과/업무역량/태도·조직문화적합도/안전및규정준수/리더십)을 불러와 저장할 수 있다", async ({ page }) => {
    await loginAsAdmin(page);
    await page.evaluate(() => {
      gotoPage("eval-ops");
      _evalOpsTab = "comp-settings";
      renderEvalOpsPage();
    });
    await page.locator("button", { hasText: "업종별 평가요소 프리셋 불러오기" }).click();
    // askConfirmModal 확인창
    await page.locator(".modal-ov").last().getByRole("button", { name: "불러오기" }).click();

    await expect(page.locator("#comp-items-comp")).toContainText("안전및규정준수");
    await expect(page.locator("#comp-items-comp")).toContainText("성과(Performance)");
    await expect(page.locator("#comp-items-comp")).toContainText("태도·조직문화적합도");

    const result = await page.evaluate(async () => {
      saveCompItems();
      await _doSave(true);
      const r = await serverRequest("GET", "/data");
      const items = r.data?.settings?.compEvalItems || [];
      const cats = [...new Set(items.map((i) => i.cat))];
      return { count: items.length, cats };
    });
    expect(result.count).toBe(10);
    expect(result.cats).toEqual(
      expect.arrayContaining(["성과(Performance)", "업무역량", "태도·조직문화적합도", "안전및규정준수", "리더십역량"])
    );
  });

  test("계산 로직이 새 카테고리를 업무역량 가중치 버킷으로 포함해 더 이상 무가중치로 조용히 누락되지 않는다", async ({ page }) => {
    await loginAsAdmin(page);
    const result = await page.evaluate(() => {
      const target = { id: 99301, empNo: "E99301", name: "스코어테스트", dept: "개발본부", team: "T1", rank: "사원", role: "member", active: true, hire: "2024-01-01", hrHistory: [] };
      employees.push(target);
      const session = { id: 88801, targetId: target.id, type: "comp", evaluatorIds: [1], status: "open", year: 2026 };
      compSessions.push(session);
      compResponses.push({
        id: 55501, sessionId: session.id, targetId: target.id, evaluatorId: 1, year: 2026, type: "comp",
        answers: { v1: 5, c1: 1 }, collab: true, strengths: "ok", improvements: "", submittedAt: new Date().toISOString(),
      });
      // 커스텀 카테고리 문항이 포함된 설정
      settings.compEvalItems = [
        { id: "v1", cat: "가치역량", q: "가치역량 문항" },
        { id: "c1", cat: "안전및규정준수", q: "커스텀 카테고리 문항" },
      ];
      const withCustom = calcCompScore(session.id);
      // 같은 응답인데 항목 목록에서 커스텀 카테고리 문항만 뺀 경우와 비교 — 실제로
      // 집계에 영향을 줬어야(=드롭되지 않았어야) 두 값이 달라진다.
      settings.compEvalItems = [{ id: "v1", cat: "가치역량", q: "가치역량 문항" }];
      const withoutCustom = calcCompScore(session.id);
      return { withCustom, withoutCustom };
    });
    // getCompWeights(사원)={value:40,biz:60,leader:0}. vAvg=5,bAvg=1(커스텀→biz버킷)일 때
    // weighted=(5*40+1*60)/100*20=52, score=Math.round(52*5)=260.
    // 커스텀 문항을 빼면 bAvg=0 → weighted=(5*40)/100*20=40, score=200.
    expect(result.withCustom).toBe(260);
    expect(result.withoutCustom).toBe(200);
    expect(result.withCustom).not.toBe(result.withoutCustom);
  });

  test("기본 3카테고리(가치역량/업무역량/리더십역량) 전부 만점이면 리팩터 이전과 동일하게 500점이 나온다(회귀 방지)", async ({ page }) => {
    await loginAsAdmin(page);
    const maxScore = await page.evaluate(() => {
      settings.compEvalItems = [];
      settings.leadershipEvalItems = [];
      const target = { id: 99302, empNo: "E99302", name: "맥스테스트", dept: "개발본부", team: "T1", rank: "사원", role: "member", active: true, hire: "2024-01-01", hrHistory: [] };
      employees.push(target);
      const session = { id: 88802, targetId: target.id, type: "comp", evaluatorIds: [1], status: "open", year: 2026 };
      compSessions.push(session);
      const answers = {};
      COMP_FORM_ITEMS.forEach((it) => (answers[it.id] = 5));
      compResponses.push({
        id: 55502, sessionId: session.id, targetId: target.id, evaluatorId: 1, year: 2026, type: "comp",
        answers, collab: true, strengths: "ok", improvements: "", submittedAt: new Date().toISOString(),
      });
      return calcCompScore(session.id);
    });
    expect(maxScore).toBe(500);
  });
});

test.describe("직무별 KPI 템플릿 라이브러리(hrmind 참고자료 대응)", () => {
  test("관리자가 템플릿 카테고리·항목을 추가하면 실제로 서버에 영속된다", async ({ page }) => {
    await loginAsAdmin(page);
    const result = await page.evaluate(async () => {
      gotoPage("eval-ops");
      _evalOpsTab = "kpi-templates";
      renderEvalOpsPage();
      _kpiTplStage = JSON.parse(JSON.stringify(kpiTemplateLibrary()));
      _kpiTplStage["테스트직군"] = [
        { name: "테스트 KPI 항목", goal: "목표 가이드", strategy: "전략 가이드", evalCriteria: "기준 가이드" },
      ];
      saveKpiTemplateLibrary();
      await _doSave(true);
      const r = await serverRequest("GET", "/data");
      const lib = r.data?.settings?.kpiTemplateLibrary || {};
      return { hasCategory: !!lib["테스트직군"], item: lib["테스트직군"]?.[0] };
    });
    expect(result.hasCategory).toBe(true);
    expect(result.item).toEqual({
      name: "테스트 KPI 항목", goal: "목표 가이드", strategy: "전략 가이드", evalCriteria: "기준 가이드",
    });
  });

  test("KPI 추가 모달에서 템플릿을 불러오면 항목명/목표/전략/기준이 채워지고, 선택기를 닫아도 원래 모달은 그대로 유지된다", async ({ page }) => {
    await loginAsAdmin(page);
    await page.evaluate(() => {
      settings.evalYear = 2026;
      settings.kpiTemplateLibrary = {
        "개발자(Backend/Frontend/Fullstack)": [
          { name: "배포 성공률·장애 MTTR 개선", goal: "배포 성공률 OO% 이상", strategy: "배포 자동화 파이프라인 점검", evalCriteria: "월별 배포 성공률 집계" },
        ],
      };
      kpiSelUserId = currentUser.id;
      gotoPage("kpi");
    });
    await page.locator("#content").getByRole("button", { name: "+ KPI 추가" }).click();
    await page.locator(".modal-ov").last().getByRole("button", { name: "📚 템플릿 불러오기" }).click();

    const picker = page.locator(".modal-ov").last();
    await expect(picker).toContainText("배포 성공률·장애 MTTR 개선");
    await picker.locator(".ta-btn", { hasText: "배포 성공률·장애 MTTR 개선" }).click();

    // 선택기 모달은 닫히고, 그 아래 KPI 추가 모달이 그대로 남아 필드가 채워져 있어야 한다.
    await expect(page.locator("#ka-item")).toHaveValue("배포 성공률·장애 MTTR 개선");
    await expect(page.locator("#ka-goal")).toHaveValue("배포 성공률 OO% 이상");
    await expect(page.locator("#ka-str")).toHaveValue("배포 자동화 파이프라인 점검");
    await expect(page.locator("#ka-crit")).toHaveValue("월별 배포 성공률 집계");
    await expect(page.locator(".modal-ov")).toHaveCount(1); // 선택기는 닫히고 추가 모달 1개만 남음
    await expect(page.locator(".modal-head h2", { hasText: "KPI 추가" })).toBeVisible();
  });

  test("KPI 수정 모달에서 템플릿 선택기를 열었다 닫아도 편집 잠금이 조용히 풀리지 않는다(closeModal()의 잠금해제 부작용을 피해가는지 확인)", async ({ page }) => {
    await loginAsAdmin(page);
    await page.evaluate(() => {
      settings.evalYear = 2026;
      settings.kpiTemplateLibrary = { "영업": [{ name: "매출 목표 달성", goal: "", strategy: "", evalCriteria: "" }] };
      kpiEntries.push({
        id: 66601, userId: currentUser.id, year: 2026, item: "잠금테스트목표", weight: 20,
        firstStatus: "", finalStatus: "", goalSub: 0, isDraft: false,
      });
      kpiSelUserId = currentUser.id;
      gotoPage("kpi");
    });
    await page.locator("#kpi-cards-area button", { hasText: "수정" }).click();
    await expect(page.locator(".modal-head h2", { hasText: "KPI 수정" })).toBeVisible();

    const lockHeldBefore = await page.evaluate(() => _myLocks.has("kpi:66601"));
    expect(lockHeldBefore).toBe(true);

    await page.locator(".modal-ov").last().getByRole("button", { name: "📚 템플릿 불러오기" }).click();
    await page.locator(".modal-ov").last().getByRole("button", { name: "닫기" }).click();

    // 선택기만 닫혔을 뿐, 그 아래 'KPI 수정' 모달과 그 편집 잠금은 그대로 유지돼야 한다.
    await expect(page.locator(".modal-ov")).toHaveCount(1);
    await expect(page.locator(".modal-head h2", { hasText: "KPI 수정" })).toBeVisible();
    const lockHeldAfter = await page.evaluate(() => _myLocks.has("kpi:66601"));
    expect(lockHeldAfter).toBe(true);
  });
});
