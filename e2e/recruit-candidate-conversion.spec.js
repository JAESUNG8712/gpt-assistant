const { test, expect } = require("@playwright/test");

// 작업2(항목E) — 채용 소스추적 + 지원자→직원 전환(반자동). 지원자 등록/수정/대시보드/
// CSV의 source 필드는 server.js 단위테스트(test/api-recruit-source-conversion.test.js)가
// 이미 커버하므로, 이 e2e는 "👤 직원으로 등록" 버튼 → 신규 직원 등록 폼 프리필 →
// 제출 → 지원자 상태 "입사" 전환까지의 전체 UI 흐름이 실제 서버와 맞물려 끝까지
// 동작하는지에 집중한다(이 프로젝트의 기존 e2e 분담 원칙과 동일).

async function loginAsAdmin(page) {
  await page.goto("/");
  await page.fill("#l-id", "e2e_admin");
  await page.fill("#l-pw", "E2eTestPw123");
  // SSE 백그라운드 재동기화만 막는다(이 프로젝트의 확립된 관례, eval-item-kpi-templates.spec.js
  // 참고) — loadFromServer는 일부러 막지 않는다. 이 스펙의 두 번째 테스트가 _doSave(true)로
  // 실제 저장을 강제하는데, 같은 e2e 스위트 전체가 서버/DATA_FILE 하나를 공유하는 구조상
  // loadFromServer를 로그인 전에 막아두면 다른 스펙이 이미 올려둔 최신 singleton revision을
  // 이 세션이 전혀 모르는 채로 저장을 시도해 SINGLETON_REVISION_CONFLICT로 전체 /save 요청이
  // 조용히 거부되고(방금 등록한 직원도 서버에 반영되지 않아 뒤이은 전환 API가 404) — 로그인
  // 직후 실제 loadFromServer를 한 번 돌려 revision을 동기화한 뒤에만 테스트별 상태를 덧붙인다.
  await page.evaluate(() => {
    autoSaveDebounced = () => {};
    connectSSE = async () => {};
  });
  await page.click(".login-card button.btn-primary");
  await expect(page.locator("#main")).toBeVisible({ timeout: 10000 });
  await page.evaluate(() => loadFromServer());
  await page.evaluate(() => {
    loadFromServer = async () => {};
  });
}

test.describe("채용 소스추적 + 지원자→직원 전환", () => {
  test("최종합격 지원자만 '직원으로 등록' 버튼이 보이고, 전환 완료 후에는 '직원등록됨' 표시로 바뀐다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await loginAsAdmin(page);

    const seeded = await page.evaluate(async () => {
      const job = await serverRequest("POST", "/api/recruit/jobs", {
        title: "전환버튼테스트직무", department: "영업본부", stages: ["서류전형", "최종합격"],
      });
      const notYet = await serverRequest("POST", "/api/recruit/candidates", {
        jobId: job.job.id, name: "아직서류전형", source: "추천",
      });
      const final1 = await serverRequest("POST", "/api/recruit/candidates", {
        jobId: job.job.id, name: "전환대상1", source: "채용사이트",
      });
      await serverRequest("POST", `/api/recruit/candidates/${final1.candidate.id}/status`, { status: "최종합격" });
      const list = await serverRequest("GET", "/api/recruit/candidates");
      recruitJobs = [job.job];
      recruitCandidates = list.candidates;
      _recruitLoaded = true;
      return { notYetId: notYet.candidate.id, final1Id: final1.candidate.id };
    });

    await page.evaluate(() => gotoPage("recruit-candidates"));
    const row1 = page.locator("tr", { hasText: "아직서류전형" });
    await expect(row1.getByRole("button", { name: "👤 직원으로 등록" })).toHaveCount(0);

    const row2 = page.locator("tr", { hasText: "전환대상1" });
    await expect(row2.getByRole("button", { name: "👤 직원으로 등록" })).toBeVisible();

    expect(pageErrors).toEqual([]);
  });

  test("버튼 클릭 → 신규 직원 등록 폼이 지원자 정보로 프리필 → 등록 제출 시 지원자 상태가 '입사'로 전환되고 employeeId가 기록된다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await loginAsAdmin(page);

    const seeded = await page.evaluate(async () => {
      const job = await serverRequest("POST", "/api/recruit/jobs", {
        title: "전환완료테스트직무", department: "영업본부", stages: ["서류전형", "최종합격"],
      });
      const cand = await serverRequest("POST", "/api/recruit/candidates", {
        jobId: job.job.id, name: "전환지원자", email: "convert@example.com", phone: "010-1234-5678",
        finalEducation: "컴퓨터공학 학사",
        careerHistory: "1. 2022.01~2024.12 | 전직장 | 개발자 | 백엔드 개발",
        source: "채용사이트",
      });
      const bump = await serverRequest("POST", `/api/recruit/candidates/${cand.candidate.id}/status`, { status: "최종합격" });
      recruitJobs = [job.job];
      recruitCandidates = [bump.candidate];
      _recruitLoaded = true;
      return { candidateId: bump.candidate.id };
    });

    await page.evaluate(() => gotoPage("recruit-candidates"));
    await page.getByRole("button", { name: "👤 직원으로 등록" }).click();

    // 신규 직원 등록 폼으로 이동해 지원자 정보가 프리필됐는지 확인.
    await expect(page.locator("#hr-name")).toHaveValue("전환지원자");
    await expect(page.locator("#hr-email")).toHaveValue("convert@example.com");
    await expect(page.locator("#hr-phone")).toHaveValue("010-1234-5678");
    const markerValue = await page.locator("#hr-converting-candidate-id").inputValue();
    expect(markerValue).toBe(seeded.candidateId);
    // 경력사항(자유텍스트)은 커스텀 필드로 참고용 노출됨.
    await expect(page.locator("#custom-fields-list")).toContainText("지원자 경력사항");

    // 관리자가 나머지 필수 항목(사번/입사일/부서/팀 등)을 검토·입력 후 제출.
    await page.fill("#hr-empno", "CONV-001");
    await page.fill("#hr-hire", "2026-10-13");
    await page.selectOption("#hr-dept", { label: "영업본부" });
    await page.selectOption("#hr-team", { label: "국내영업팀" });
    await page.click("button:has-text('입사자 등록')");

    await expect(page.locator(".toast").last()).toContainText('"입사"로 전환');

    const result = await page.evaluate(async (candidateId) => {
      const localCand = recruitCandidates.find((c) => c.id === candidateId);
      const localEmp = employees.find((e) => e.empNo === "CONV-001");
      const fresh = await serverRequest("GET", `/api/recruit/candidates/${candidateId}`);
      return { localCand, localEmp, serverCand: fresh.candidate };
    }, seeded.candidateId);

    expect(result.localEmp).toBeTruthy();
    expect(result.localCand.status).toBe("입사");
    expect(result.localCand.employeeId).toBe(String(result.localEmp.id));
    // 서버에 실제로 저장된 지원자 레코드도 동일하게 전환돼 있는지 재조회로 확인.
    expect(result.serverCand.status).toBe("입사");
    expect(result.serverCand.employeeId).toBe(String(result.localEmp.id));

    // 지원자 목록으로 돌아가면 이제 "직원등록됨" 표시만 보이고 버튼은 사라진다.
    await page.evaluate(() => gotoPage("recruit-candidates"));
    const row = page.locator("tr", { hasText: "전환지원자" });
    await expect(row).toContainText("직원등록됨");
    await expect(row.getByRole("button", { name: "👤 직원으로 등록" })).toHaveCount(0);

    expect(pageErrors).toEqual([]);
  });
});
