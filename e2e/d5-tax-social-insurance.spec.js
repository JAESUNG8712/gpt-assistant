const { test, expect } = require("@playwright/test");

// D5(HR마인드 벤치마킹 2차 라운드) — 세무/사회보험 참고용 화면 + 단체보험 등록. 세 기능 모두
// "실제 전자신고/보험사 가입을 대체하지 않는 참고용 기록·조회"로 범위를 명시적으로 줄인
// 기능이라(사용자 확인), 서버측 신규 검증 없이 다른 admin 전용 참고 기록(wageGarnishments 등)
// 과 동일한 admin 전체신뢰 모델을 그대로 따른다 — 이 e2e는 화면 흐름(등록/수정/삭제/CSV,
// 퇴직자 대상 등록, 기존 근태 데이터 기반 신고서 집계)에 집중한다.

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
// 가로채 검증할 수 있도록 가짜 창 객체로 교체한다(printWorkDetailsReport는 pw.focus()/
// pw.print()/pw.close()까지 직접 호출하므로 전부 no-op으로 제공해야 한다).
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

test.describe("D5 — 4대보험 신고 내역(참고용)", () => {
  test("자격취득·자격상실(퇴직자 포함)·보수월액변경 등록/수정/삭제/CSV가 정상 동작한다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await loginAsAdmin(page);

    await page.evaluate(() => {
      employees.push(
        { id: 98501, empNo: "E98501", name: "사대보험1", dept: "경영지원본부", team: "인사팀", active: true, hire: "2026-01-02", hrHistory: [], role: "member" },
        { id: 98502, empNo: "E98502", name: "사대보험2", dept: "경영지원본부", team: "인사팀", active: false, hire: "2020-01-01", retireDate: "2025-12-31", hrHistory: [], role: "member" },
      );
    });

    await page.evaluate(() => gotoPage("tax-social-insurance"));
    await expect(page.locator("#content")).toContainText("4대보험 신고 내역");

    // 1) 자격취득(입사) — 재직자, 4대보험 기본 전체 체크, 신고 보수월액 입력
    await page.click("button:has-text('＋ 신고 등록')");
    await page.fill("#si-emp-search", "사대보험1");
    await page.selectOption("#si-emp-select", { label: "사대보험1 · 경영지원본부 인사팀" });
    await page.fill("#si-date", "2026-01-02");
    await page.fill("#si-wage", "3500000");
    await page.click(".modal-foot button:has-text('저장')");
    await expect(page.locator(".modal-box")).toHaveCount(0);
    await expect(page.locator("tr:has-text('사대보험1')")).toContainText("자격취득");
    await expect(page.locator("tr:has-text('사대보험1')")).toContainText("국민연금");
    await expect(page.locator("tr:has-text('사대보험1')")).toContainText("3,500,000");

    // 2) 자격상실(퇴사) — 이미 퇴직 처리된 직원도 검색에 "(퇴직)" 표시로 나타나고 등록 가능해야 한다
    await page.click("button:has-text('＋ 신고 등록')");
    await page.fill("#si-emp-search", "사대보험2");
    await expect(page.locator("#si-emp-select")).toContainText("(퇴직)");
    await page.selectOption("#si-emp-select", { label: "사대보험2 (퇴직) · 경영지원본부 인사팀" });
    await page.selectOption("#si-type", "loss");
    await page.fill("#si-date", "2025-12-31");
    await page.fill("#si-reason", "자진퇴사");
    await page.click(".modal-foot button:has-text('저장')");
    await expect(page.locator(".modal-box")).toHaveCount(0);
    await expect(page.locator("tr:has-text('사대보험2')")).toContainText("자격상실");
    await expect(page.locator("tr:has-text('사대보험2')")).toContainText("자진퇴사");

    const recordsAfterCreate = await page.evaluate(() => socialInsuranceRecords.map((r) => ({ empId: r.empId, type: r.type, insuranceTypes: r.insuranceTypes, monthlyWage: r.monthlyWage, reason: r.reason })));
    expect(recordsAfterCreate.find((r) => r.empId === 98501).type).toBe("acquisition");
    expect(recordsAfterCreate.find((r) => r.empId === 98501).insuranceTypes.sort()).toEqual(["employment", "health", "industrial", "pension"]);
    expect(recordsAfterCreate.find((r) => r.empId === 98501).monthlyWage).toBe(3500000);
    expect(recordsAfterCreate.find((r) => r.empId === 98502).type).toBe("loss");
    expect(recordsAfterCreate.find((r) => r.empId === 98502).reason).toBe("자진퇴사");

    // 3) 보수월액변경 등록
    await page.click("button:has-text('＋ 신고 등록')");
    await page.fill("#si-emp-search", "사대보험1");
    await page.selectOption("#si-emp-select", { label: "사대보험1 · 경영지원본부 인사팀" });
    await page.selectOption("#si-type", "wageChange");
    await page.fill("#si-date", "2026-04-01");
    await page.fill("#si-wage", "3800000");
    await page.fill("#si-reason", "승급");
    await page.click(".modal-foot button:has-text('저장')");
    await expect(page.locator(".modal-box")).toHaveCount(0);
    await expect(page.locator("tr:has-text('승급')")).toContainText("보수월액변경");

    // 4) 기존 등록(사대보험1의 자격취득) 수정 — 대상자는 변경 불가, 비고만 수정
    await page.click("tr:has-text('자격취득') button:has-text('수정')");
    await expect(page.locator(".modal-box")).toContainText("대상자는 변경할 수 없습니다");
    await page.fill("#si-note", "수정된 비고");
    await page.click(".modal-foot button:has-text('저장')");
    await expect(page.locator(".modal-box")).toHaveCount(0);
    await expect(page.locator("tr:has-text('자격취득')")).toContainText("수정된 비고");
    const empIdUnchanged = await page.evaluate(() => socialInsuranceRecords.find((r) => r.type === "acquisition").empId);
    expect(empIdUnchanged).toBe(98501);

    // 5) 삭제(자격상실 건) — 확인 모달 경유
    const countBefore = await page.evaluate(() => socialInsuranceRecords.length);
    await page.click("tr:has-text('사대보험2') button:has-text('삭제')");
    await page.click(".modal-foot button:has-text('확인')");
    await expect(page.locator("#content")).not.toContainText("사대보험2");
    const countAfter = await page.evaluate(() => socialInsuranceRecords.length);
    expect(countAfter).toBe(countBefore - 1);

    // 6) CSV 다운로드 — 남은 2건(자격취득/보수월액변경)이 헤더·내용 그대로 반영된다
    await page.evaluate(() => {
      window.__csvCalls = [];
      dlCSV = async (fn, headers, rows) => { window.__csvCalls.push({ fn, headers, rows }); };
    });
    await page.click("button:has-text('📥 다운로드')");
    const csv = await page.evaluate(() => window.__csvCalls[0]);
    expect(csv.headers).toEqual(["이름", "사번", "부서", "팀", "구분", "4대보험", "발생일", "신고보수월액", "사유", "비고"]);
    const wageChangeRow = csv.rows.find((r) => r[4] === "보수월액변경");
    expect(wageChangeRow[0]).toBe("사대보험1");
    expect(wageChangeRow[1]).toBe("E98501");
    expect(wageChangeRow[7]).toBe(3800000);
    expect(wageChangeRow[8]).toBe("승급");

    // 코드관리 허브에 건수가 반영된다
    await page.evaluate(() => gotoPage("code-mgmt"));
    await expect(page.locator("#content")).toContainText("4대보험 신고 내역");

    expect(pageErrors).toEqual([]);
  });

  test("4대보험 항목을 하나도 선택하지 않으면 저장이 차단된다", async ({ page }) => {
    // 발생일 등 .req 표시가 붙은 일반 입력 필드가 비어있는 경우는 이미 전역 가이드
    // 검증(_validateEditorScope, 3171행 인근)이 클릭 자체를 막고 공용 안내 토스트를
    // 띄운다 — 이 화면 고유 로직이 아니므로 별도로 검증하지 않는다. 4대보험 체크박스는
    // 그 전역 검증 대상(input[type=checkbox] 제외)이 아니라서, saveSocialInsuranceRecord()
    // 자신의 검증이 실제로 동작하는지는 이 테스트로만 확인할 수 있다.
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await loginAsAdmin(page);

    await page.evaluate(() => {
      employees.push({ id: 98505, empNo: "E98505", name: "사대보험검증", dept: "경영지원본부", team: "인사팀", active: true, hire: "2022-01-01", hrHistory: [], role: "member" });
    });

    await page.evaluate(() => gotoPage("tax-social-insurance"));
    await page.click("button:has-text('＋ 신고 등록')");
    await page.fill("#si-emp-search", "사대보험검증");
    await page.selectOption("#si-emp-select", { label: "사대보험검증 · 경영지원본부 인사팀" });
    await page.fill("#si-date", "2026-05-01");
    for (const chk of await page.locator(".si-ins-chk").all()) await chk.uncheck();
    await page.click(".modal-foot button:has-text('저장')");
    await expect(page.locator(".toast")).toContainText("4대보험 항목을 하나 이상 선택");
    await expect(page.locator(".modal-box")).toHaveCount(1); // 저장 실패로 모달이 그대로 유지됨

    const count = await page.evaluate(() => socialInsuranceRecords.length);
    expect(count).toBe(0);

    expect(pageErrors).toEqual([]);
  });
});

test.describe("D5 — 근로내역확인신고서 출력(참고용)", () => {
  test("기존 근태 기록으로 근무일수·근로시간·지급임금을 집계해 출력한다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await loginAsAdmin(page);

    await page.evaluate(() => {
      employees.push({ id: 98506, empNo: "E98506", name: "근로내역테스트", dept: "경영지원본부", team: "인사팀", active: true, hire: "2022-01-01", salary: 42000000, hrHistory: [], role: "member" });
      attendanceRecords.push(
        { id: "att-98506-2026-02-02", empId: 98506, date: "2026-02-02", checkIn: "09:00", checkOut: "18:00", status: "normal", note: "", updatedAt: new Date().toISOString() },
        { id: "att-98506-2026-02-03", empId: 98506, date: "2026-02-03", checkIn: "09:00", checkOut: "18:00", status: "normal", note: "", updatedAt: new Date().toISOString() },
        { id: "att-98506-2026-02-04", empId: 98506, date: "2026-02-04", checkIn: "09:00", checkOut: "20:00", status: "normal", note: "", updatedAt: new Date().toISOString() }, // 2시간 연장
      );
    });

    const expected = await page.evaluate(() => {
      const emp = getEmp(98506);
      const { regularHours, overtimeHours } = _calcMonthlyWorkHours(98506, 2026, 2);
      const slip = calcStandardPayslip(emp, 2026, 2);
      return { totalHours: Math.round((regularHours + overtimeHours) * 10) / 10, gross: slip.gross };
    });
    expect(expected.totalHours).toBe(26); // 8h + 8h + (8h 소정 + 2h 연장) = 24h 소정 + 2h 연장

    await page.evaluate(() => gotoPage("tax-social-insurance"));
    await page.click("button:has-text('근로내역확인신고서 출력')");
    await page.selectOption("#si-wr-emp", "98506");
    await page.fill("#si-wr-year", "2026");
    await page.fill("#si-wr-month", "2");

    await captureNextPrintWindow(page);
    await page.click("button:has-text('🖨 신고서 출력')");
    await page.waitForTimeout(200);
    const printHtml = await page.evaluate(() => window.__lastPrintHtml);
    expect(printHtml).toContain("근로내역테스트");
    expect(printHtml).toContain("3일"); // 근무일수(세 날짜 모두 checkIn+checkOut 존재)
    expect(printHtml).toContain(`${expected.totalHours}시간`);
    expect(printHtml).toContain(expected.gross.toLocaleString());

    expect(pageErrors).toEqual([]);
  });

  test("대상자를 선택하지 않으면 출력이 차단된다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await loginAsAdmin(page);

    await page.evaluate(() => gotoPage("tax-social-insurance"));
    await page.click("button:has-text('근로내역확인신고서 출력')");
    await captureNextPrintWindow(page);
    await page.click("button:has-text('🖨 신고서 출력')");
    await expect(page.locator(".toast")).toContainText("대상자를 선택하세요");
    const printHtml = await page.evaluate(() => window.__lastPrintHtml);
    expect(printHtml).toBeNull();

    expect(pageErrors).toEqual([]);
  });
});

test.describe("D5 — 단체보험 등록(참고용)", () => {
  test("계약 추가·수정·검증·삭제가 정상 동작한다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await loginAsAdmin(page);

    await page.evaluate(() => gotoPage("welfare-settings"));
    await page.click(".tab-btn:has-text('🛡 단체보험')");
    await expect(page.locator("#content")).toContainText("단체보험 등록");

    await page.click("button:has-text('+ 계약 추가')");
    // <input value="...">는 textContent에 포함되지 않아 toContainText로는 보이지
    // 않는다 — 실제 저장된 값은 항상 settings.groupInsurancePolicies를 직접 확인한다.
    // 이 테스트 동안 행이 정확히 1개뿐이라 tr:has-text() 대신 테이블의 유일한 행을
    // 그대로 가리키는 scoped 로케이터를 쓴다(입력값 기반 hasText 매칭에 의존하지 않음).
    const row = page.locator("#welfare-settings-content table tbody tr").first();
    await expect(row).toBeVisible();
    await row.locator("input").nth(0).fill("임직원 단체상해보험");
    await row.locator("input").nth(1).fill("테스트생명");
    await row.locator("input").nth(2).fill("상해/질병");
    await row.locator("input").nth(3).fill("전 직원");
    await row.locator("input[type=date]").nth(0).fill("2026-01-01");
    await row.locator("input[type=date]").nth(1).fill("2026-12-31");
    await row.locator("input[type=number]").fill("12000000");
    // fill()은 'input' 이벤트만 발생시키고, onchange는 포커스가 다른 곳으로 옮겨질 때
    // (blur) 브라우저가 자연히 발생시키는 'change' 이벤트로 트리거된다 — 체인의 마지막
    // 입력칸은 이어서 포커스를 옮길 동작이 없어 onchange가 영원히 발생하지 않으므로,
    // 다음 필드로 넘어가는 각 fill()이 자연히 그 앞 필드를 blur시키는 것과 달리 이
    // 체인의 "마지막" 입력 뒤에는 명시적으로 blur()를 호출해야 한다.
    await row.locator("input[type=number]").blur();

    const saved = await page.evaluate(() => settings.groupInsurancePolicies[0]);
    expect(saved.policyName).toBe("임직원 단체상해보험");
    expect(saved.insurer).toBe("테스트생명");
    expect(saved.coverageType).toBe("상해/질병");
    expect(saved.coveredScope).toBe("전 직원");
    expect(saved.startDate).toBe("2026-01-01");
    expect(saved.endDate).toBe("2026-12-31");
    expect(saved.premiumTotal).toBe(12000000);

    // 종료일이 개시일보다 빠르면 거부되고 기존 값이 유지된다
    await row.locator("input[type=date]").nth(1).fill("2025-01-01");
    await row.locator("input[type=date]").nth(1).blur();
    await expect(page.locator(".toast")).toContainText("종료일은 개시일보다 빠를 수 없습니다");
    const afterInvalidDate = await page.evaluate(() => settings.groupInsurancePolicies[0].endDate);
    expect(afterInvalidDate).toBe("2026-12-31");

    // 총 보험료가 범위를 벗어나면 거부되고 기존 값이 유지된다
    await row.locator("input[type=number]").fill("-5");
    await row.locator("input[type=number]").blur();
    await expect(page.locator(".toast").last()).toContainText("총 보험료는 0~9,999,999,999원");
    const afterInvalidPremium = await page.evaluate(() => settings.groupInsurancePolicies[0].premiumTotal);
    expect(afterInvalidPremium).toBe(12000000);

    // 삭제
    await row.locator("button:has-text('삭제')").click();
    await page.click(".modal-foot button:has-text('확인')");
    await expect(page.locator("#content")).toContainText("등록된 단체보험 계약이 없습니다");
    const afterDelete = await page.evaluate(() => settings.groupInsurancePolicies.length);
    expect(afterDelete).toBe(0);

    expect(pageErrors).toEqual([]);
  });
});
