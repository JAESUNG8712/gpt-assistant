const { test, expect } = require("@playwright/test");

// D4(HR마인드 벤치마킹 2차 라운드) — 급여/퇴직 고도화. 기존 연봉제 계산 경로(annual÷12)는
// settings.payBasisMode 기본값("annual")에서 완전히 동일하게 유지되어야 하므로(하위호환
// 필수), 호봉제(step)로 전환했을 때만 다른 산식이 적용되는지와 더불어 전환 전/후 비교로
// 회귀가 없는지 함께 검증한다. 급여압류·퇴직금 정산은 각각 calcStandardPayslip()의
// 순수 가산 공제, calcSeverancePay()의 periodStart/asOfDate 오버라이드만 사용하므로
// 기존 "예상 퇴직금"·급여 명세서 계산을 건드리지 않는다.

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

// window.open()이 실제 팝업을 띄우는 대신, document.write()로 넘어온 HTML 문자열을
// 가로채 검증할 수 있도록 가짜 창 객체로 교체한다(printSeveranceStatement는
// pw.focus()/pw.print()/pw.close()까지 직접 호출하므로 전부 no-op으로 제공해야 한다).
async function captureNextPrintWindow(page) {
  await page.evaluate(() => {
    window.__lastPrintHtml = null;
    window.open = function () {
      const fakeDoc = {
        write(html) { window.__lastPrintHtml = html; },
        close() {},
      };
      return { document: fakeDoc, print() {}, close() {}, focus() {} };
    };
  });
}

test.describe("D4 — 호봉제(급여 지급 기준)", () => {
  test("연봉제 기본값은 기존 산식과 동일하고, 호봉제로 전환하면 호봉표 금액이 반영된다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await loginAsAdmin(page);

    // 다른 D시리즈 e2e가 공유 DATA_FILE의 orgDB.ranks를 바꿀 수 있으므로, 이 스펙 전용
    // 고유 직급을 새로 추가해 사용한다(기존 기본 직급 목록 상태에 의존하지 않음).
    await page.evaluate(() => {
      if (!orgDB.ranks.includes("호봉테스트직급")) orgDB.ranks.push("호봉테스트직급");
      employees.push({
        id: 98401, empNo: "E98401", name: "호봉테스트", dept: "경영지원본부", team: "인사팀",
        rank: "호봉테스트직급", rankYear: 2, position: "", active: true, hire: "2022-01-01",
        salary: 42000000, hrHistory: [], role: "member",
      });
    });

    // 전환 전(연봉제, 기본값) — 기존 산식(연봉÷12)과 동일해야 한다.
    const beforeMonthly = await page.evaluate(() => {
      const emp = getEmp(98401);
      return calcStandardPayslip(emp, 2026, 6).monthly;
    });
    expect(beforeMonthly).toBe(Math.round(42000000 / 12) - 0 + 100000); // researchAllow=0(비R&BD), transportIncluded=100000

    // 급여 관리 설정에서 호봉제로 전환하고 "호봉테스트직급" 2호봉에 금액을 입력한다.
    await page.evaluate(() => gotoPage("payroll-settings"));
    await page.selectOption(".card:has-text('급여 지급 기준') select", "step");
    await expect(page.locator(".card:has-text('급여 지급 기준')")).toContainText("호봉");
    await page.click("button:has-text('+ 호봉 추가')"); // 기본 1열(1호봉)뿐이라 2호봉 열을 먼저 추가
    const stepInput = page.locator("tr:has-text('호봉테스트직급') input").nth(1); // 2호봉(index 1) 입력칸
    await stepInput.fill("3200000");
    await page.click("button:has-text('💾 변경사항 저장')");
    await expect(page.locator(".toast")).toContainText("저장되었습니다");

    const afterMonthly = await page.evaluate(() => {
      const emp = getEmp(98401);
      return calcStandardPayslip(emp, 2026, 6).monthly;
    });
    expect(afterMonthly).toBe(3200000 + 100000); // 호봉표 금액 - researchAllow(0) + transportIncluded
    expect(afterMonthly).not.toBe(beforeMonthly);

    const savedMode = await page.evaluate(() => settings.payBasisMode);
    expect(savedMode).toBe("step");

    // 다시 연봉제로 되돌리면 기존 산식으로 완전히 복귀한다(하위호환 — 저장된 호봉표는 보존됨).
    await page.evaluate(() => gotoPage("payroll-settings"));
    await page.selectOption(".card:has-text('급여 지급 기준') select", "annual");
    await page.click("button:has-text('💾 변경사항 저장')");
    const revertedMonthly = await page.evaluate(() => {
      const emp = getEmp(98401);
      return calcStandardPayslip(emp, 2026, 6).monthly;
    });
    expect(revertedMonthly).toBe(beforeMonthly);
    const stepTablePreserved = await page.evaluate(() => (settings.salaryStepTable || {})["호봉테스트직급"]);
    expect(stepTablePreserved[1]).toBe(3200000);

    expect(pageErrors).toEqual([]);
  });

  test("호봉제 사용 시 모든 직급의 호봉 금액이 0이면 저장이 차단된다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await loginAsAdmin(page);

    await page.evaluate(() => { settings.payBasisMode = "annual"; settings.salaryStepTable = {}; });
    await page.evaluate(() => gotoPage("payroll-settings"));
    await page.selectOption(".card:has-text('급여 지급 기준') select", "step");
    await page.click("button:has-text('💾 변경사항 저장')");

    await expect(page.locator(".toast")).toContainText("호봉 금액");
    const savedMode = await page.evaluate(() => settings.payBasisMode);
    expect(savedMode).toBe("annual"); // 검증 실패로 저장되지 않아야 함(기존 값 유지)

    expect(pageErrors).toEqual([]);
  });
});

test.describe("D4 — 급여 압류 등록", () => {
  test("고정액·비율 압류가 급여 공제에 반영되고, 해제 후에는 반영이 멈춘다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await loginAsAdmin(page);

    await page.evaluate(() => {
      employees.push(
        { id: 98402, empNo: "E98402", name: "압류테스트1", dept: "경영지원본부", team: "인사팀", rank: "사원(대졸)", position: "", active: true, hire: "2022-01-01", salary: 48000000, hrHistory: [], role: "member" },
        { id: 98403, empNo: "E98403", name: "압류테스트2", dept: "경영지원본부", team: "인사팀", rank: "사원(대졸)", position: "", active: true, hire: "2022-01-01", salary: 48000000, hrHistory: [], role: "member" },
      );
    });

    // 1) 고정액 압류 등록 — 적용기간을 비워 무기한으로 둔다.
    await page.evaluate(() => gotoPage("wage-garnishment"));
    await page.click("button:has-text('＋ 압류 등록')");
    await page.click(".modal-box button:has-text('직원 선택')");
    const picker1 = page.locator(".modal-box", { hasText: "압류 대상 직원 선택" });
    await picker1.locator("#op-search").fill("압류테스트1");
    await picker1.locator("#op-tree label", { hasText: "압류테스트1" }).click();
    await picker1.locator("button", { hasText: "선택 완료" }).click();
    await expect(page.locator("#wg-emp-picked")).toContainText("압류테스트1");
    await page.fill("#wg-case", "2026카명1234");
    await page.fill("#wg-creditor", "테스트법무사");
    await page.fill("#wg-amount", "500000");
    await page.click(".modal-foot button:has-text('저장')");
    await expect(page.locator(".modal-box")).toHaveCount(0);
    await expect(page.locator("#content")).toContainText("압류테스트1");

    const slip1 = await page.evaluate(() => calcStandardPayslip(getEmp(98402), 2026, 6));
    expect(slip1.garnishDeduct).toBe(500000);
    expect(slip1.deductItems.some((d) => d.label.includes("급여압류"))).toBe(true);
    expect(slip1.totalDeduct - slip1.garnishDeduct).toBeGreaterThan(0);

    // 2) 실수령액 비율 압류 등록(두번째 직원) — preGarnishNet × rate% 와 일치해야 한다.
    await page.click("button:has-text('＋ 압류 등록')");
    await page.click(".modal-box button:has-text('직원 선택')");
    const picker2 = page.locator(".modal-box", { hasText: "압류 대상 직원 선택" });
    await picker2.locator("#op-search").fill("압류테스트2");
    await picker2.locator("#op-tree label", { hasText: "압류테스트2" }).click();
    await picker2.locator("button", { hasText: "선택 완료" }).click();
    await page.selectOption("#wg-type", "percentOfNet");
    await page.fill("#wg-rate", "20");
    await page.click(".modal-foot button:has-text('저장')");
    await expect(page.locator(".modal-box")).toHaveCount(0);

    const result2 = await page.evaluate(() => {
      const emp = getEmp(98403);
      const withGarnish = calcStandardPayslip(emp, 2026, 6);
      // 압류 전 순수 공제(압류 제외 totalDeduct = preGarnishNet 산출 기준)를, 해당 직원분만
      // 잠시 제외한 배열로 재계산해 구한다(baseTotalDeduct 자체가 압류와 무관하므로 일치해야 함).
      const saved = wageGarnishments;
      wageGarnishments = wageGarnishments.filter((g) => String(g.empId) !== String(emp.id));
      const withoutGarnish = calcStandardPayslip(emp, 2026, 6);
      wageGarnishments = saved;
      return { garnishDeduct: withGarnish.garnishDeduct, preGarnishNet: withGarnish.gross - withoutGarnish.totalDeduct };
    });
    expect(result2.garnishDeduct).toBe(Math.round(result2.preGarnishNet * 0.2));

    // 3) 적용기간을 벗어난(미래 시작월) 압류는 해당 연월에 반영되지 않는다.
    await page.evaluate(() => {
      wageGarnishments.push({ id: "wg-future-test", empId: 98402, empName: "압류테스트1", type: "fixed", amount: 999999, status: "active", startMonth: "2030-01", endMonth: "", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    });
    const futureScoped = await page.evaluate(() => calcStandardPayslip(getEmp(98402), 2026, 6).garnishDeduct);
    expect(futureScoped).toBe(500000); // 기존(무기한) 압류만 반영, 미래분은 아직 반영 안 됨
    await page.evaluate(() => { wageGarnishments = wageGarnishments.filter((g) => g.id !== "wg-future-test"); });

    // 4) 해제하면 더 이상 공제에 반영되지 않는다.
    await page.evaluate(() => gotoPage("wage-garnishment"));
    await page.click("tr:has-text('압류테스트1') button:has-text('해제')");
    await page.click(".modal-foot button:has-text('해제')");
    await expect(page.locator("#content")).toContainText("해제");

    const slip1After = await page.evaluate(() => calcStandardPayslip(getEmp(98402), 2026, 6));
    expect(slip1After.garnishDeduct).toBe(0);

    // 5) 급여 명세서 화면·인쇄·ERP연동 CSV에 "급여압류" 공제가 노출된다(압류테스트2는 여전히 활성).
    //    payslip은 _MY_PAGE_PW_GUARD 대상이라 본인확인을 거치지 않으면 gotoPage()가
    //    실제 이동 대신 확인 모달을 띄운다 — 이 흐름 자체는 테스트 대상이 아니므로 우회한다.
    await page.evaluate(() => { currentUser = { ...currentUser, id: 98403, name: "압류테스트2", role: "member", dept: "경영지원본부", team: "인사팀" }; _myPagePwVerified = true; });
    await page.evaluate(() => gotoPage("payslip"));
    await expect(page.locator("#content")).toContainText("급여압류");

    await captureNextPrintWindow(page);
    await page.evaluate(() => { const now = new Date(); printPayslip(98403, now.getFullYear(), now.getMonth() + 1); });
    await page.waitForTimeout(200);
    const printHtml = await page.evaluate(() => window.__lastPrintHtml);
    expect(printHtml).toContain("급여압류");

    await page.evaluate(() => { currentUser = { ...currentUser, id: 1, name: "e2e_admin", role: "admin" }; });
    await page.evaluate(() => {
      window.__csvCalls = [];
      dlCSV = async (fn, headers, rows) => { window.__csvCalls.push({ fn, headers, rows }); };
    });
    await page.evaluate(() => exportPayrollForErp());
    const csv = await page.evaluate(() => window.__csvCalls[0]);
    expect(csv.headers[csv.headers.length - 1]).toBe("급여압류");
    const rowFor403 = csv.rows.find((r) => r[0] === "E98403");
    expect(rowFor403[rowFor403.length - 1]).toBeGreaterThan(0);

    expect(pageErrors).toEqual([]);
  });
});

test.describe("D4 — 퇴직금 정산모듈", () => {
  test("정산 등록 시 기존 예상퇴직금 산식을 재사용하고, 다음 정산은 직전 정산일 이후 기간만 재산정한다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await loginAsAdmin(page);

    await page.evaluate(() => {
      employees.push({ id: 98404, empNo: "E98404", name: "정산테스트", dept: "경영지원본부", team: "인사팀", rank: "사원(대졸)", position: "", active: true, hire: "2020-01-01", salary: 60000000, hrHistory: [], role: "member" });
    });

    // 1) 중간정산 등록 — periodStart는 입사일부터여야 한다(이전 정산 없음).
    await page.evaluate(() => gotoPage("severance-settlement"));
    await page.click("button:has-text('＋ 정산 등록')");
    await page.fill("#sev-emp-search", "정산테스트");
    await page.selectOption("#sev-emp-select", { label: "정산테스트 · 경영지원본부 인사팀" });
    await page.selectOption("#sev-type", "interim");
    await page.fill("#sev-date", "2023-12-31");
    await expect(page.locator("#sev-preview")).toContainText("2020-01-01");
    const previewAmount1 = await page.evaluate(() => window._sevPreview.severance);
    await expect(page.locator("#sev-amount")).toHaveValue(String(previewAmount1));
    await page.fill("#sev-reason", "주택구입");
    await page.click(".modal-foot button:has-text('저장')");
    await expect(page.locator(".modal-box")).toHaveCount(0);
    await expect(page.locator("#content")).toContainText("정산테스트");
    await expect(page.locator("#content")).toContainText("중간정산");

    const expected1 = await page.evaluate(() => calcSeverancePay(getEmp(98404), { periodStart: "2020-01-01", asOfDate: "2023-12-31" }).severance);
    expect(previewAmount1).toBe(expected1);

    // 2) 두번째(최종) 정산 등록 — periodStart는 직전 정산일(2023-12-31) 다음날이어야 한다.
    await page.click("button:has-text('＋ 정산 등록')");
    await page.fill("#sev-emp-search", "정산테스트");
    await page.selectOption("#sev-emp-select", { label: "정산테스트 · 경영지원본부 인사팀" });
    await page.selectOption("#sev-type", "final");
    await page.fill("#sev-date", "2026-06-30");
    await expect(page.locator("#sev-preview")).toContainText("2024-01-01"); // 직전 정산일(2023-12-31) 다음날
    await expect(page.locator("#sev-preview")).not.toContainText("2020-01-01");
    const previewAmount2 = await page.evaluate(() => window._sevPreview.severance);
    const expected2 = await page.evaluate(() => calcSeverancePay(getEmp(98404), { periodStart: "2024-01-01", asOfDate: "2026-06-30" }).severance);
    expect(previewAmount2).toBe(expected2);
    await page.click(".modal-foot button:has-text('저장')");
    await expect(page.locator(".modal-box")).toHaveCount(0);

    const settlementsCount = await page.evaluate(() => severanceSettlements.filter((s) => s.empId === 98404).length);
    expect(settlementsCount).toBe(2);

    // 3) 정산서 인쇄 — 성명·정산액이 포함된다.
    const lastId = await page.evaluate(() => severanceSettlements.filter((s) => s.empId === 98404).sort((a, b) => String(b.settlementDate).localeCompare(String(a.settlementDate)))[0].id);
    await captureNextPrintWindow(page);
    await page.evaluate((id) => printSeveranceStatement(id), lastId);
    await page.waitForTimeout(200);
    const printHtml = await page.evaluate(() => window.__lastPrintHtml);
    expect(printHtml).toContain("정산테스트");
    expect(printHtml).toContain("최종");

    // 4) 전사 퇴직급여추계액 — 정산 이력이 있는 직원은 "직전(=가장 최근) 정산일" 다음날부터만,
    //    없는 직원은 입사일부터 집계되어야 한다. 기준일(asOf)은 정산테스트의 마지막(최종) 정산일인
    //    2026-06-30보다 "나중"이어야 한다 — 기준일을 정산일과 같게 두면 그 사이 경과일이 0이라
    //    추계액 집계(days>0 필터)에서 아예 빠지므로, 의도적으로 한달 뒤(2026-07-31)로 조회한다.
    //    두 값 모두 calcSeverancePay()를 직접 호출한 결과와 정확히 일치해야 한다(참고용 계산의 일관성).
    await page.evaluate(() => {
      employees.push({ id: 98405, empNo: "E98405", name: "정산없음", dept: "경영지원본부", team: "인사팀", active: true, hire: "2021-06-01", salary: 36000000, hrHistory: [], role: "member" });
    });
    await page.evaluate(() => gotoPage("severance-settlement"));
    await page.click(".tab-btn:has-text('퇴직급여추계액')");
    await page.fill("#sev-reserve-asof", "2026-07-31");
    await expect(page.locator("#content")).toContainText("정산테스트");
    await expect(page.locator("#content")).toContainText("정산없음");

    await page.evaluate(() => {
      window.__csvCalls = [];
      dlCSV = async (fn, headers, rows) => { window.__csvCalls.push({ fn, headers, rows }); };
    });
    await page.click("button:has-text('📥 다운로드')");
    const csv = await page.evaluate(() => window.__csvCalls[0]);
    const rowWithSettlement = csv.rows.find((r) => r[0] === "정산테스트");
    const rowNoSettlement = csv.rows.find((r) => r[0] === "정산없음");
    expect(rowWithSettlement[4]).toBe("2026-07-01"); // 산정기간시작 = 마지막(최종) 정산일(2026-06-30) 다음날
    expect(rowNoSettlement[4]).toBe("2021-06-01"); // 산정기간시작 = 입사일

    const [expectedWithSettlement, expectedNoSettlement] = await page.evaluate(() => [
      calcSeverancePay(getEmp(98404), { periodStart: "2026-07-01", asOfDate: "2026-07-31" }).severance,
      calcSeverancePay(getEmp(98405), { periodStart: "2021-06-01", asOfDate: "2026-07-31" }).severance,
    ]);
    expect(rowWithSettlement[9]).toBe(expectedWithSettlement);
    expect(rowNoSettlement[9]).toBe(expectedNoSettlement);

    expect(pageErrors).toEqual([]);
  });
});
