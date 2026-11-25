const { test, expect } = require("./fixtures");

// 채용 전환 후 온보딩 자동 연계. 지원자→직원 전환(recruit-candidate-conversion.spec.js)이
// 성공하면, 신규 입사자의 온보딩 체크리스트(ONBOARD_TEMPLATE)가 함께 열리고 서버에 저장된다.
// 같은 흐름에서 온보딩 메뉴를 끈 관리자는 직원 등록과 상태 전환은 되지만 절차는 만들지 않는다.

async function loginAsAdmin(page) {
  await page.goto("/");
  await page.fill("#l-id", "e2e_admin");
  await page.fill("#l-pw", "E2eTestPw123");
  // 다른 채용·전환 스펙과 같은 확립된 관례: 로그인 직후 실제 loadFromServer로 revision을
  // 동기화한 뒤에만 테스트 상태를 덧붙인다(recruit-candidate-conversion.spec.js 참고).
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

async function seedFinalCandidate(page, name) {
  return page.evaluate(async (candName) => {
    const job = await serverRequest("POST", "/api/recruit/jobs", {
      title: `온보딩연계-${candName}`, department: "영업본부", stages: ["서류전형", "최종합격"],
    });
    const cand = await serverRequest("POST", "/api/recruit/candidates", {
      jobId: job.job.id, name: candName, email: "onb@example.com", phone: "010-9999-0000",
      source: "채용사이트",
    });
    const bump = await serverRequest("POST", `/api/recruit/candidates/${cand.candidate.id}/status`, { status: "최종합격" });
    recruitJobs = [job.job];
    recruitCandidates = [bump.candidate];
    _recruitLoaded = true;
    return { candidateId: bump.candidate.id };
  }, name);
}

async function submitHireForm(page, empNo) {
  await page.getByRole("button", { name: "👤 직원으로 등록" }).click();
  await expect(page.locator("#hr-converting-candidate-id")).toHaveCount(1);
  await page.fill("#hr-empno", empNo);
  await page.fill("#hr-hire", "2026-10-13");
  await page.selectOption("#hr-dept", { label: "영업본부" });
  await page.selectOption("#hr-team", { label: "국내영업팀" });
  await page.click("button:has-text('입사자 등록')");
}

test.describe("채용 전환 → 온보딩 자동 연계", () => {
  test("전환에 성공하면 온보딩 체크리스트가 자동 생성·저장되고, 목록에 '채용 전환'으로 표시된다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await loginAsAdmin(page);
    const seeded = await seedFinalCandidate(page, "온보딩연계1");

    await page.evaluate(() => gotoPage("recruit-candidates"));
    await submitHireForm(page, "ONB-001");
    await expect(page.locator(".toast").last()).toContainText("온보딩 절차도 자동으로 시작");

    const result = await page.evaluate(async (candidateId) => {
      const emp = employees.find((e) => e.empNo === "ONB-001");
      const flows = onboardingFlows.filter((f) => String(f.empId) === String(emp?.id));
      const fresh = await serverRequest("GET", "/data");
      const serverFlows = (fresh.data.onboardingFlows || []).filter((f) => String(f.empId) === String(emp?.id));
      return {
        empId: emp?.id,
        localFlows: flows,
        serverFlows,
        candidateId,
      };
    }, seeded.candidateId);

    expect(result.localFlows).toHaveLength(1);
    const flow = result.localFlows[0];
    expect(flow.type).toBe("onboard");
    expect(flow.sourceCandidateId).toBe(result.candidateId);
    expect(flow.items.map((i) => i.label)).toEqual([
      "근로계약서 서명", "보안서약서 서명", "PC·장비 지급", "계정 발급(그룹웨어/메일)",
      "사원증 발급", "오리엔테이션 교육", "멘토(버디) 지정", "4대보험 취득 신고",
    ]);
    expect(flow.items.every((i) => i.done === false)).toBe(true);

    // 서버에 실제로 저장됐는지 재조회로 확인(이 spec 전용 직원 id로만 검증).
    expect(result.serverFlows).toHaveLength(1);
    expect(result.serverFlows[0].sourceCandidateId).toBe(result.candidateId);

    // 온보딩 화면 목록에 채용 전환 표시가 나온다.
    await page.evaluate(() => gotoPage("onboarding"));
    await expect(page.locator("text=채용 전환").first()).toBeVisible();

    expect(pageErrors).toEqual([]);
  });

  test("온보딩 메뉴를 끈 관리자는 전환(직원 등록·상태 '입사')은 되지만 온보딩 절차는 만들어지지 않는다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await loginAsAdmin(page);
    const seeded = await seedFinalCandidate(page, "온보딩연계2");

    await page.evaluate(() => {
      currentUser.menuPerms = { ...(currentUser.menuPerms || {}), onboarding: false };
    });
    await page.evaluate(() => gotoPage("recruit-candidates"));
    await submitHireForm(page, "ONB-002");
    await expect(page.locator(".toast").last()).toContainText('"입사"로 전환');

    const result = await page.evaluate(async (candidateId) => {
      const emp = employees.find((e) => e.empNo === "ONB-002");
      const cand = await serverRequest("GET", `/api/recruit/candidates/${candidateId}`);
      return {
        empId: emp?.id,
        flows: onboardingFlows.filter((f) => String(f.empId) === String(emp?.id)),
        status: cand.candidate.status,
      };
    }, seeded.candidateId);

    expect(result.status).toBe("입사");
    expect(result.flows).toHaveLength(0);
    expect(pageErrors).toEqual([]);
  });
});
