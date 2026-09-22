// P1-3 e2e 스캐폴드의 최소 스모크 테스트. playwright.config.js의 webServer가
// test/support/start-e2e-server.js로 서버를 띄우고(관리자 e2e_admin/E2eTestPw123
// 사전 시딩됨), 여기서는 그 서버를 상대로 실제 브라우저 로그인·기본 네비게이션만
// 확인한다. 화면별 상세 시나리오는 이 스캐폴드 위에 추가해 나가면 된다.
const { test, expect } = require("@playwright/test");

test.describe("로그인·기본 네비게이션", () => {
  test("hosted 앱은 ?srv와 저장된 서버 URL 대신 same-origin API만 사용한다", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => localStorage.setItem("hr_kpi_server_url", "https://evil.example"));
    await page.goto("/?srv=https%3A%2F%2Fevil.example");

    const config = await page.evaluate(() => ({
      url: serverConfig.url,
      effective: _effectiveServerUrl(),
      locked: _isServerUrlLocked(),
      stored: localStorage.getItem("hr_kpi_server_url"),
      shared: Boolean(window._isSharedDeployLink),
    }));

    expect(config.locked).toBe(true);
    expect(config.url).toBe(new URL(page.url()).origin);
    expect(config.effective).toBe(new URL(page.url()).origin);
    expect(config.stored).toBeNull();
    expect(config.shared).toBe(false);
  });

  test("로그인 레이블과 공용 알림이 보조기기에 연결된다", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator('label[for="l-company"]')).toBeVisible();
    await expect(page.locator('label[for="l-id"]')).toBeVisible();
    await expect(page.locator('label[for="l-pw"]')).toBeVisible();

    await page.evaluate(() => showToast("저장 완료", "success"));
    await expect(page.locator('.toast[role="status"][aria-live="polite"]')).toContainText("저장 완료");
    await page.evaluate(() => showToast("저장 실패", "error"));
    await expect(page.locator('.toast[role="alert"][aria-live="assertive"]')).toContainText("저장 실패");
  });

  test("잘못된 비밀번호는 오류를 보여준다", async ({ page }) => {
    await page.goto("/");
    await page.fill("#l-id", "e2e_admin");
    await page.fill("#l-pw", "wrong-password");
    await page.click(".login-card button.btn-primary");
    await expect(page.locator("#login-err")).toContainText(/./, { timeout: 5000 });
  });

  test("정상 로그인 후 대시보드가 렌더링되고 콘솔 에러가 없다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", e => pageErrors.push(e.message));

    await page.goto("/");
    await page.fill("#l-id", "e2e_admin");
    await page.fill("#l-pw", "E2eTestPw123");
    await page.click(".login-card button.btn-primary");

    await expect(page.locator("#main")).toBeVisible({ timeout: 10000 });
    await expect(page.locator("#topbar-username")).toContainText("E2E관리자");
    await expect(page.getByRole("button", { name: /^알림/ })).toBeVisible();

    expect(pageErrors, `콘솔 페이지 에러 발생: ${pageErrors.join("; ")}`).toHaveLength(0);
  });

  test("인사관리 > 직원목록으로 이동해도 에러 없이 렌더링된다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", e => pageErrors.push(e.message));

    await page.goto("/");
    await page.fill("#l-id", "e2e_admin");
    await page.fill("#l-pw", "E2eTestPw123");
    await page.click(".login-card button.btn-primary");
    await expect(page.locator("#main")).toBeVisible({ timeout: 10000 });

    await page.evaluate(() => gotoPage("hr-list"));
    await expect(page.locator("#hr-list-search")).toBeVisible({ timeout: 5000 });
    await expect(page.locator("#hr-list-tbl")).toContainText("E2E관리자", { timeout: 5000 });

    expect(pageErrors, `콘솔 페이지 에러 발생: ${pageErrors.join("; ")}`).toHaveLength(0);
  });

  test("사업장 마스터의 검증·등록·직원 필터·삭제 보호가 동작한다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", e => pageErrors.push(e.message));
    await page.goto("/");
    await page.fill("#l-id", "e2e_admin");
    await page.fill("#l-pw", "E2eTestPw123");
    await page.click(".login-card button.btn-primary");
    await expect(page.locator("#main")).toBeVisible({ timeout: 10000 });

    await page.evaluate(() => gotoPage("settings-org"));
    await expect(page.getByRole("heading", { name: /사업장·근무지 관리/ })).toBeVisible();
    await page.getByRole("button", { name: "+ 사업장 추가" }).click();
    let dialog = page.locator('[role="dialog"][aria-modal="true"]');
    await dialog.locator("#wp-code").fill("한글 코드");
    await dialog.locator("#wp-name").fill("QA 사업장");
    await dialog.getByRole("button", { name: /^저장$/ }).click();
    await expect(page.locator('.toast[role="alert"]').last()).toContainText(/사업장 코드/);
    await expect(dialog).toBeVisible();

    await dialog.locator("#wp-code").fill("E2E_SITE");
    await dialog.locator("#wp-bizno").fill("1234567890");
    await dialog.getByRole("button", { name: /^저장$/ }).click();
    await expect(page.locator("#settings-content")).toContainText("QA 사업장");
    const saved = await page.evaluate(() => orgDB.workplaces.find(w => w.code === "E2E_SITE"));
    expect(saved.businessNo).toBe("123-45-67890");

    await page.evaluate(() => gotoPage("hr-list"));
    await expect(page.locator("#hr-list-search")).toBeVisible();
    await expect(page.locator("#content select option", { hasText: "QA 사업장" })).toHaveCount(1);

    await page.evaluate(() => gotoPage("settings-org"));
    await page.evaluate(() => {
      const site = orgDB.workplaces.find(w => w.code === "E2E_SITE");
      employees[0].workplaceId = site.id;
      renderSettingsOrg();
    });
    let row = page.locator("tr", { hasText: "QA 사업장" });
    await row.getByRole("button", { name: "삭제" }).click();
    await expect(page.locator('.toast[role="alert"]').last()).toContainText(/배정되어 있어 삭제할 수 없습니다/);

    await page.evaluate(() => {
      employees[0].workplaceId = "";
      renderSettingsOrg();
    });
    row = page.locator("tr", { hasText: "QA 사업장" });
    await row.getByRole("button", { name: "삭제" }).click();
    dialog = page.locator('[role="dialog"][aria-modal="true"]');
    await expect(dialog).toContainText("배정 직원");
    await dialog.getByRole("button", { name: "사업장 삭제" }).click();
    await expect(page.locator("#settings-content")).not.toContainText("QA 사업장");
    expect(pageErrors, `콘솔 페이지 에러 발생: ${pageErrors.join("; ")}`).toHaveLength(0);
  });

  test("모든 메뉴 그룹이 대분류에 속하고 회계 입력 예시·템플릿·검증이 동작한다", async ({ page }) => {
    await page.goto("/");
    await page.fill("#l-id", "e2e_admin");
    await page.fill("#l-pw", "E2eTestPw123");
    await page.click(".login-card button.btn-primary");
    await expect(page.locator("#main")).toBeVisible({ timeout: 10000 });

    const uncovered = await page.evaluate(() => Object.keys(_menuGroupsCache).filter(group => !_bigCatForGroup(group)));
    expect(uncovered).toEqual([]);

    await page.evaluate(async () => { await loadAccountingFromServer(); gotoPage("acct-accounts"); });
    await expect(page.getByRole("heading", { name: /계정과목 관리/ })).toBeVisible();
    await page.evaluate(() => openAcctAccountModal());
    const dialog = page.locator('[role="dialog"][aria-modal="true"]');
    await expect(dialog).toContainText("기본 계정과목");
    await expect(dialog.locator("#acc-code")).toHaveAttribute("placeholder", /예:/);
    await expect(dialog.locator("#acc-name")).toHaveAttribute("placeholder", /예:/);
    await dialog.locator("#acc-code").fill("잘못된 코드");
    await dialog.locator("#acc-name").fill("테스트 계정");
    await dialog.getByRole("button", { name: /^저장$/ }).click();
    await expect(page.locator('.toast[role="alert"]')).toContainText(/계정코드|영문|숫자/);
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");

    await page.evaluate(async () => { gotoPage("acct-vouchers"); await openVoucherModal(); });
    const voucherDialog = page.locator('[role="dialog"][aria-modal="true"]');
    await expect(voucherDialog).toContainText("작성 방법");
    await expect(voucherDialog.locator("#vch-desc")).toHaveAttribute("placeholder", /예:/);
    await voucherDialog.locator("#vch-template").selectOption("builtin-expense-cash");
    await expect(voucherDialog.locator("#vch-lines select")).toHaveCount(2);
  });

  test("급여 계산식 대상·기간 조건과 단계형 워크플로우가 동작한다", async ({ page }) => {
    await page.goto("/");
    await page.fill("#l-id", "e2e_admin");
    await page.fill("#l-pw", "E2eTestPw123");
    await page.click(".login-card button.btn-primary");
    await expect(page.locator("#main")).toBeVisible({ timeout: 10000 });

    const calculated = await page.evaluate(() => {
      const before = settings.customPayItems;
      settings.customPayItems = [
        { id: "rate", name: "부서수당", type: "pay", calcType: "monthlyRate", rate: 10, targetType: "dept", targetValue: "개발", startMonth: "2026-01", endMonth: "2026-12", order: 2, enabled: true },
        { id: "other", name: "타부서수당", type: "pay", calcType: "fixed", amount: 999999, targetType: "dept", targetValue: "영업", order: 1, enabled: true },
      ];
      const slip = calcStandardPayslip({ id: "formula-e2e", salary: 60000000, dept: "개발", team: "플랫폼", rank: "대리", position: "", active: true }, 2026, 9);
      const validAdjustment = _buildPayrollAdjustment({ empId: "formula-e2e", year: 2026, month: 9, category: "기타 인센티브", amount: 1234.6, note: "공통 생성기" });
      const invalidAdjustment = _buildPayrollAdjustment({ empId: "formula-e2e", year: 2026, month: 13, category: "기타 인센티브", amount: 1000 });
      settings.customPayItems = before;
      return { monthly: slip.monthly, matched: slip.payItems.find(i => i.label === "부서수당")?.amount, excluded: slip.payItems.some(i => i.label === "타부서수당"), adjustment: validAdjustment.record, invalidError: invalidAdjustment.error };
    });
    expect(calculated.matched).toBe(Math.round(calculated.monthly * 0.1));
    expect(calculated.excluded).toBe(false);
    expect(calculated.adjustment).toMatchObject({ empId: "formula-e2e", year: 2026, month: 9, category: "기타 인센티브", amount: 1235, note: "공통 생성기", source: "manual", taxable: true });
    expect(calculated.adjustment.id).toMatch(/^payadj-/);
    expect(calculated.invalidError).toMatch(/월은 1~12월/);

    await page.evaluate(() => gotoPage("payroll-settings"));
    await expect(page.getByRole("heading", { name: /수당·공제 계산식 설정/ })).toBeVisible();
    await page.getByRole("button", { name: "+ 항목 추가" }).click();
    await expect(page.locator("#content")).toContainText("월 기본급 비율");
    await expect(page.locator("#content")).toContainText("대상 기준");
    await expect(page.locator("#content input[type=month]")).toHaveCount(2);

    await page.evaluate(() => { _opsStage = null; gotoPage("payroll-mgmt"); });
    await expect(page.getByText("급여 작업 워크플로우")).toBeVisible();
    await expect(page.getByText("대상자 확인")).toBeVisible();
    await expect(page.getByRole("button", { name: /일괄 계산/ })).toBeVisible();
  });

  test("확정 평가가 성과급과 급여로 중복 없이 연결되고 확정 급여는 보호된다", async ({ page }) => {
    await page.goto("/");
    await page.fill("#l-id", "e2e_admin");
    await page.fill("#l-pw", "E2eTestPw123");
    // 로그인 직후 _completeLogin()이 트리거하는 두 백그라운드 동기화 경로
    // — checkServerConnection→GET /status→admin 자동 upsert→loadFromServer(), 그리고
    // 그 upsert 저장이 브로드캐스트하는 SSE data_updated(같은 클라이언트도 수신) —
    // 가 둘 다 applyState()로 전체 상태를 서버 진짜 값으로 덮어쓴다(회사 간 데이터
    // 잔류 방지를 위한 의도된 설계, _completeLogin 주석 참고). 이 테스트가 로그인
    // 직후 순수 인메모리로 시딩하는 employees/settings/mandatoryTraining 등은
    // 서버에 저장된 적이 없으므로, 이 두 체인 중 하나라도 시딩 "이후" 도착하면
    // 조용히 지워져 flaky해진다(실측: 로그인 "후"에 오버라이드하면 8회 중 최대
    // 5회 재현 — _completeLogin이 클릭 즉시 체인을 시작해 오버라이드보다 먼저
    // 끝나버릴 수 있음). 로그인 버튼을 누르기 "전"에 오버라이드해야(이 시점에
    // 이미 두 함수 모두 전역에 정의돼 있음) 체인 자체가 시작부터 무력화되어
    // 결정론적으로 안전하다(수정 후 8/8 재검증).
    await page.evaluate(() => {
      autoSaveDebounced = () => {};
      loadFromServer = async () => {};
      connectSSE = async () => {};
    });
    await page.click(".login-card button.btn-primary");
    await expect(page.locator("#main")).toBeVisible({ timeout: 10000 });

    const candidate = await page.evaluate(async () => {
      autoSaveDebounced = () => {};
      autoSaveToServerIfEnabled = () => Promise.resolve();
      const emp = {
        id: "performance-e2e", empNo: "E2E-PERF", name: "성과연계검증", role: "member",
        active: true, salary: 72000000, dept: "개발", team: "플랫폼", rank: "대리",
        gradeResults: { "2026": { score: 90, grade: "S" } },
        hrHistory: [
          { id: "edu-perf-e2e", type: "edu_general", date: "2026-05-10", desc: "직무 심화 교육" },
          { id: "award-perf-e2e", type: "award", date: "2026-06-30", year: 2026, half: "상반기", tier: "최우수", desc: "최우수사원 선정" },
          { id: "award-perf-e2e-duplicate", type: "award", date: "2026-06-30", year: 2026, half: "상반기", tier: "최우수", desc: "레거시 중복 선정" },
          { id: "salary-perf-e2e", type: "salary", date: "2027-01-01", before: "60,000,000원", after: "72,000,000원", desc: "연봉 조정" },
        ],
      };
      employees.push(emp);
      compGradeResults[emp.id] = { "2026": { score: 80, grade: "A" } };
      settings.mandatoryTrainingTypes = [
        { id: "privacy", name: "개인정보보호", required: true },
        { id: "safety", name: "산업안전", required: true },
      ];
      mandatoryTraining.push(
        { id: "mt-perf-1", empId: emp.id, trainingType: "privacy", year: 2026, completedAt: "2026-03-01" },
        { id: "mt-perf-2", empId: emp.id, trainingType: "safety", year: 2026, completedAt: "2026-03-02" },
      );
      settings.scoreWeights = { kpi: 60, comp: 20, ls: 20 };
      settings.performanceRewardPolicy = {
        enabled: true, basis: "annualSalary", requireKpi: true, requireComp: true, requireMandatoryTraining: true,
        maxAmount: 100000000, gradeRates: { S: 20, A: 10, B: 5, C: 0, D: 0 },
        awardBonusAmounts: { "우수": 500000, "최우수": 1000000 },
      };
      // 다른 E2E 시나리오 또는 시드의 급여 마감 상태와 무관하게 이 연계 흐름만 검증한다.
      settings.payrollLockedMonths = (settings.payrollLockedMonths || []).filter(key => key !== "2099-3" && key !== "2100-4");
      payrollAdjustments = payrollAdjustments.filter(a => a.sourceKey !== "performance:2026:performance-e2e");
      payslips = payslips.filter(p => String(p.empId) !== emp.id);
      _payMgmtState = { year: 2099, month: 3, dept: "", team: "", search: "성과연계검증" };
      _perfRewardState = { evalYear: 2026 };
      const row = _performanceRewardCandidate(emp, 2026);
      // Prepare and apply in one browser task so intermediate rendering cannot
      // replace the global payroll filter/target state between those operations.
      askConfirmModal = async () => true;
      await applyPerformanceRewards();
      const applied = payrollAdjustments.some(a => a.sourceKey === row.sourceKey);
      payrollAdjustments.push({
        id: "legacy-duplicate-performance", empId: emp.id, year: 2099, month: 3,
        amount: 7000000, source: "performance_reward", sourceKey: row.sourceKey, evalYear: 2026,
      });
      await applyPerformanceRewards();
      const linked = payrollAdjustments.filter(a => a.sourceKey === row.sourceKey);
      compGradeResults[emp.id]["2026"] = { score: 0, grade: "D" };
      const drift = _performanceRewardCandidate(emp, 2026);
      openEmpDetail(emp.id);
      const dialogText = document.querySelector('[role="dialog"][aria-modal="true"]')?.textContent || "";
      closeModal();
      compGradeResults[emp.id]["2026"] = { score: 80, grade: "A" };
      payslips.push({ empId: emp.id, year: 2100, month: 4, confirmed: true });
      _payMgmtState.year = 2100;
      _payMgmtState.month = 4;
      const before = payrollAdjustments.find(a => a.sourceKey === row.sourceKey).month;
      await applyPerformanceRewards();
      const after = payrollAdjustments.find(a => a.sourceKey === row.sourceKey).month;
      const protectedToast = Array.from(document.querySelectorAll('.toast[role="alert"]')).at(-1)?.textContent || "";
      const safeEmp = {
        ...emp,
        id: "performance-e2e-safe", empNo: "E2E-PERF-SAFE", name: "성과연계검증-추가",
        hrHistory: emp.hrHistory.map((item, index) => ({ ...item, id: `safe-history-${index}` })),
      };
      employees.push(safeEmp);
      compGradeResults[safeEmp.id] = { "2026": { score: 80, grade: "A" } };
      mandatoryTraining.push(
        { id: "mt-perf-safe-1", empId: safeEmp.id, trainingType: "privacy", year: 2026, completedAt: "2026-03-01" },
        { id: "mt-perf-safe-2", empId: safeEmp.id, trainingType: "safety", year: 2026, completedAt: "2026-03-02" },
      );
      await applyPerformanceRewards();
      const safeLinked = payrollAdjustments.find(a => a.sourceKey === "performance:2026:performance-e2e-safe");
      const protectedAfterPartial = payrollAdjustments.find(a => a.sourceKey === row.sourceKey).month;
      const partialToast = Array.from(document.querySelectorAll('.toast')).at(-1)?.textContent || "";
      openPerformanceRewardPreview();
      const previewText = document.querySelector('[role="dialog"][aria-modal="true"]')?.textContent || "";
      closeModal();
      gotoPage("payroll-mgmt");
      return { applied, linked, dialogText, drift: { needsReview: drift.needsReview, reasons: drift.driftReasons }, protectedResult: { before, after, protectedToast }, partialResult: { safeYear: safeLinked?.year, safeMonth: safeLinked?.month, protectedAfter: protectedAfterPartial, partialToast, previewText }, ready: row.ready, overall: row.overall, grade: row.grade, rate: row.rate, basisSalary: row.salaryBasis.amount, salaryReconstructed: row.salaryBasis.reconstructed, evaluationReward: row.evaluationReward, awardBonus: row.awardBonus, duplicateAwards: row.awards.duplicateCount, amount: row.amount, training: [row.education.completed, row.education.required] };
    });
    expect({ ...candidate, linked: undefined, dialogText: undefined, drift: undefined, protectedResult: undefined, partialResult: undefined }).toEqual({ applied: true, linked: undefined, dialogText: undefined, drift: undefined, protectedResult: undefined, partialResult: undefined, ready: true, overall: 86, grade: "A", rate: 10, basisSalary: 60000000, salaryReconstructed: true, evaluationReward: 6000000, awardBonus: 1000000, duplicateAwards: 1, amount: 7000000, training: [2, 2] });
    expect(candidate.linked).toHaveLength(1);
    expect(candidate.linked[0]).toMatchObject({ year: 2099, month: 3, amount: 7000000, evaluationReward: 6000000, awardBonus: 1000000, awardCounts: { "우수": 0, "최우수": 1 }, ignoredDuplicateAwards: 1, basisAnnualSalary: 60000000, basisSalaryReconstructed: true, mandatoryTraining: { required: 2, completed: 2, allCompleted: true }, source: "performance_reward" });
    expect(candidate.dialogText).toContain("직원 성과·교육·포상·보상 통합 현황");
    expect(candidate.dialogText).toContain("7,000,000원");
    expect(candidate.dialogText).toContain("최우수 1회");
    expect(candidate.dialogText).toContain("반영 후 기준 변경");
    expect(candidate.drift.needsReview).toBe(true);
    expect(candidate.drift.reasons).toEqual(expect.arrayContaining(["최종 성과급", "종합 점수", "종합 등급", "지급률"]));
    expect(candidate.protectedResult).toMatchObject({ before: 3, after: 3 });
    expect(candidate.protectedResult.protectedToast).toMatch(/확정/);
    expect(candidate.partialResult).toMatchObject({ safeYear: 2100, safeMonth: 4, protectedAfter: 3 });
    expect(candidate.partialResult.partialToast).toMatch(/확정·마감 1명은 제외/);
    expect(candidate.partialResult.previewText).toMatch(/확정·마감 보호/);
    expect(candidate.partialResult.previewText).toMatch(/실제 반영 예정 합계/);
    expect(candidate.partialResult.previewText).toMatch(/1명 제외/);
    await expect(page.getByText("평가 → 성과급 → 급여 연계")).toBeVisible();
    await expect(page.getByText("이번 반영 가능")).toBeVisible();
    await expect(page.getByText("확정·마감 제외")).toBeVisible();
  });

  test("직원 상세에서 연봉을 수정해도 연봉 변동 이력이 자동 생성된다", async ({ page }) => {
    await page.goto("/");
    await page.fill("#l-id", "e2e_admin");
    await page.fill("#l-pw", "E2eTestPw123");
    // 로그인 버튼을 누르기 "전"에 오버라이드해야 하는 이유는 위 "확정 평가가
    // 성과급과..." 테스트의 상세 주석 참고 — _completeLogin()이 클릭 즉시 시작하는
    // loadFromServer()/SSE data_updated 체인이 로그인 "후" 오버라이드보다 먼저
    // 끝나버릴 수 있어(flaky), 두 함수가 이미 전역에 정의된 이 시점에 미리 막는다.
    await page.evaluate(() => {
      autoSaveDebounced = () => {};
      loadFromServer = async () => {};
      connectSSE = async () => {};
    });
    await page.click(".login-card button.btn-primary");
    await expect(page.locator("#main")).toBeVisible({ timeout: 10000 });

    await page.evaluate(() => {
      employees.push({
        id: "salary-history-e2e", loginId: "salary-history-e2e", empNo: "E2E-SAL", name: "연봉이력검증",
        role: "member", active: true, salary: 50000000, dept: "개발", team: "플랫폼", rank: "대리",
        rankYear: 1, jobGroup: "개발", nationality: "내국인", customFields: {}, careers: [], leaves: [], hrHistory: [], gradeResults: {},
      });
      _openEmpEdit("salary-history-e2e");
    });
    const dialog = page.locator('[role="dialog"][aria-modal="true"]');
    await dialog.locator("#ee-salary").fill("55000000");
    await dialog.getByRole("button", { name: "저장" }).click();

    const result = await page.evaluate(() => {
      const emp = getEmp("salary-history-e2e"), rows = emp.hrHistory.filter(x => x.type === "salary");
      return { salary: emp.salary, count: rows.length, before: rows[0]?.before, after: rows[0]?.after, source: rows[0]?.source };
    });
    expect(result).toEqual({ salary: 55000000, count: 1, before: "50,000,000원", after: "55,000,000원", source: "employee_edit" });
  });

  test("휴가·근무보상·복리후생 정책과 채용 키워드 적합도가 연동된다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", e => pageErrors.push(e.message));
    await page.goto("/");
    await page.fill("#l-id", "e2e_admin");
    await page.fill("#l-pw", "E2eTestPw123");
    await page.click(".login-card button.btn-primary");
    await expect(page.locator("#main")).toBeVisible({ timeout: 10000 });

    await page.evaluate(() => gotoPage("attend-settings"));
    await expect(page.getByRole("heading", { name: /휴가 유형·신청 단위/ })).toBeVisible();
    await expect(page.getByRole("heading", { name: /연장·휴일근무 보상 방식/ })).toBeVisible();

    const rules = await page.evaluate(() => {
      settings.leaveTypes = [{ id: "quarter", name: "시간연차", unit: 0.25, countsAnnual: true, paid: true, enabled: true }];
      settings.workCompOptions = [{ id: "sub", name: "대체휴무", mode: "leave", expiryMonths: 3, enabled: true }];
      settings.welfarePolicies = [{ id: "marriage", group: "condolence", name: "본인 결혼", maxAmount: 1000000, minServiceMonths: 0, payrollLinked: true, enabled: true }];
      recruitJobs = [{ id: "job-match", title: "ERP 개발자", keywords: ["JavaScript", "PostgreSQL", "제조ERP"] }];
      recruitCandidates = [{ id: "candidate-match", jobId: "job-match", name: "지원자 A", status: "서류검토", finalEducation: "컴퓨터공학 학사", careerHistory: "1. 2023.01~2024.12 | 제조사 | 개발자 | 제조ERP JavaScript 개발", lastSalary: "4,000만원", desiredSalary: "4,500만원", resumeSummary: "제조ERP JavaScript 개발" }];
      const match = _recruitCandidateMatch({ jobId: "job-match", careerHistory: "제조ERP JavaScript 개발", resumeSummary: "업무 경험" });
      const historical = _orgEmployeeAtDate({ id: 99, role: "member", active: true, hire: "2020-01-01", dept: "신사업본부", team: "플랫폼팀", hrHistory: [{ type: "transfer", date: "2025-01-01", applied: true, before: "IT사업본부/서비스개발팀", after: "신사업본부/플랫폼팀" }] }, "2024-12-31");
      const flex = _flexOptionSnapshot({ id: "shift-a", label: "A조", startHour: 6, endHour: 14, breakMinutes: 30, workDays: [1, 2, 3, 4] });
      return {
        leave: _selectedLeavePolicy("시간연차"),
        comp: settings.workCompOptions[0],
        welfare: _welfarePolicyForTemplate("tpl-welfare-condolence", "marriage"),
        match,
        historical,
        flex,
      };
    });
    expect(rules.leave.unit).toBe(0.25);
    expect(rules.comp.expiryMonths).toBe(3);
    expect(rules.welfare.maxAmount).toBe(1000000);
    expect(rules.match).toEqual({ score: 67, matched: ["JavaScript", "제조ERP"], missing: ["PostgreSQL"] });
    expect(rules.historical).toMatchObject({ dept: "IT사업본부", team: "서비스개발팀" });
    expect(rules.flex).toMatchObject({ label: "A조", startHour: 6, endHour: 14, breakMinutes: 30, workDays: [1, 2, 3, 4] });

    await page.evaluate(() => openRecruitCandidateCompare("job-match"));
    await expect(page.getByRole("heading", { name: /ERP 개발자 지원자 비교/ })).toBeVisible();
    await expect(page.locator(".modal-box")).toContainText("지원자 A");
    await page.evaluate(() => closeModal());

    await page.evaluate(() => {
      _opsStage = null;
      gotoPage("welfare-settings");
      _welfareSettingsTab = "policy";
      settings.welfarePolicies = [{
        id: "marriage",
        group: "condolence",
        name: "본인 결혼",
        maxAmount: 1000000,
        minServiceMonths: 0,
        payrollLinked: true,
        enabled: true,
      }];
      renderWelfareSettingsPage();
    });
    await expect(page.getByRole("heading", { name: /경조·학자금 지원 기준/ })).toBeVisible();
    await expect(page.locator('#welfare-settings-content input[placeholder="예: 본인 결혼"]').first()).toHaveValue("본인 결혼");
    expect(pageErrors, `콘솔 페이지 에러 발생: ${pageErrors.join("; ")}`).toHaveLength(0);
  });

  test("모바일 메뉴와 공용 모달을 키보드로 닫을 수 있다", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/");
    await page.fill("#l-id", "e2e_admin");
    await page.fill("#l-pw", "E2eTestPw123");
    await page.click(".login-card button.btn-primary");
    await expect(page.locator("#main")).toBeVisible({ timeout: 10000 });

    const menu = page.locator("#mobile-menu-btn");
    await expect(page.locator("#mtab-dashboard")).toHaveAttribute("aria-current", "page");
    await expect(menu).toHaveAttribute("aria-expanded", "false");
    await menu.click();
    await expect(menu).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator("#sidebar")).toHaveClass(/open/);
    await page.keyboard.press("Escape");
    await expect(menu).toHaveAttribute("aria-expanded", "false");

    await page.evaluate(() => showModal('<section class="modal modal-sm"><div class="modal-head"><h2>접근성 검사</h2><button class="modal-close" onclick="closeModal()">×</button></div><div class="modal-body"><button type="button">확인</button></div></section>'));
    await expect(page.locator("[role=dialog][aria-modal=true]")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("[role=dialog]")).toHaveCount(0);

    await page.evaluate(() => {
      window.__confirmModalResult = "pending";
      askConfirmModal({
        title: "위험 작업 확인",
        message: "삭제 전 영향 범위를 확인합니다.",
        impacts: [{ label: "삭제 예정", value: "3건", tone: "danger" }],
        danger: true,
        confirmText: "삭제 실행",
      }).then(result => { window.__confirmModalResult = result; });
    });
    const confirmDialog = page.locator("[role=dialog][aria-modal=true]");
    await expect(confirmDialog).toBeVisible();
    await expect(confirmDialog).toContainText("삭제 예정");
    await expect(page.locator(":focus")).toHaveText("취소");
    await page.keyboard.press("Escape");
    await expect(page.locator("[role=dialog]")).toHaveCount(0);
    await page.waitForFunction(() => window.__confirmModalResult === false);
  });

  test("예산 전체 초기화는 영향 범위를 표시하고 서버 실패를 성공으로 오인하지 않는다", async ({ page }) => {
    let deleteRequests = 0;
    await page.route("**/api/budget/**", async route => {
      if (route.request().method() === "DELETE") {
        deleteRequests++;
        return route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ message: "관리자 권한이 필요합니다." }) });
      }
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ headcount: [], items: [], summary: [] }) });
    });
    await page.goto("/budget.html");

    await page.evaluate(() => {
      rawData = {
        headcount: [{ dept: '<img src=x onerror="window.__budgetXss=true">', month: 1, count: 2 }],
        items: []
      };
      renderRaw();
    });
    await expect(page.locator("#rawArea")).toContainText('<img src=x onerror="window.__budgetXss=true">');
    expect(await page.evaluate(() => window.__budgetXss)).toBeUndefined();

    await page.getByRole("button", { name: "전체 데이터 초기화" }).click();
    const dialog = page.locator("#confirm-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("영향 범위");
    await expect(page.locator(":focus")).toHaveText("취소");
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    expect(deleteRequests).toBe(0);

    await page.getByRole("button", { name: "전체 데이터 초기화" }).click();
    await dialog.getByRole("button", { name: "전체 데이터 삭제" }).click();
    await expect(page.locator("#status1")).toContainText("관리자 권한이 필요합니다.");
    expect(deleteRequests).toBe(1);
  });

  test("마스터 회사 진입은 대상 회사와 감사 범위를 확인한 뒤에만 요청한다", async ({ page }) => {
    let impersonateRequests = 0;
    await page.route("**/master/companies/**/impersonate", async route => {
      impersonateRequests++;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, token: "unused" }) });
    });
    await page.goto("/master.html");
    await page.evaluate(() => { void enterCompany("company-e2e"); });

    const dialog = page.locator("#confirm-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("company-e2e 회사 데이터");
    await expect(dialog).toContainText("감사 로그");
    await dialog.getByRole("button", { name: "취소" }).click();
    expect(impersonateRequests).toBe(0);
  });

  test("동시 수정 충돌은 최신 데이터를 다시 읽고 사용자 선택 모달을 표시한다", async ({ page }) => {
    await page.goto("/");
    await page.fill("#l-id", "e2e_admin");
    await page.fill("#l-pw", "E2eTestPw123");
    await page.click(".login-card button.btn-primary");
    await expect(page.locator("#main")).toBeVisible({ timeout: 10000 });

    await page.evaluate(() => _handleRecordRevisionConflict({
      field: "boardPosts",
      id: "e2e-concurrent-record",
      currentRevision: 2,
    }));

    const dialog = page.locator('[role="dialog"][aria-modal="true"]');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("다른 사용자가");
    await expect(dialog.getByRole("button", { name: "서버 최신 내용 유지" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "내 변경 다시 적용" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator('[role="dialog"]')).toHaveCount(0);
  });
});
