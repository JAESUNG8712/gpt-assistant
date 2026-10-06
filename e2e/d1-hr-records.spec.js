const { test, expect } = require("@playwright/test");

// D1(HR마인드 벤치마킹 2차 라운드) — 징계관리·계약관리·승진시뮬레이션·권한변경로그·
// 코드관리 통합화면. 서버측 쓰기는 기존 employees 보호(role/salary/birth/address 전용
// _sanitizeEmployeeRecord 등)를 그대로 상속하므로 이 e2e는 "화면이 올바르게 동작하고
// 올바른 서버 호출을 하는가"에 집중한다(이 프로젝트의 기존 e2e 분담 원칙과 동일).

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

test.describe("D1 — 인사기록 보강 + 코드관리", () => {
  test("통합 인사 변동 등록으로 징계를 기록하면 인사카드에 포함된다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await loginAsAdmin(page);

    await page.evaluate(() => {
      employees.push({
        id: 98101, empNo: "E98101", name: "징계대상자", dept: "경영지원본부", team: "인사팀",
        rank: "사원", position: "", active: true, hire: "2022-01-01", hrHistory: [], role: "member",
      });
    });

    await page.evaluate(() => gotoPage("hr-changes"));
    await page.evaluate(() => { hrChgEmpId = "98101"; renderHRChanges(); });
    await page.click("button:has-text('+ 인사 변동 등록')");
    await page.selectOption("#hc-type", "discipline");
    await page.fill("#hc-date", "2026-10-06");
    await page.fill("#hc-desc", "근태 수칙 위반(지각 누적)");
    await page.selectOption("#hc-discipline-level", "감봉");
    await page.click(".modal-foot button:has-text('등록')");
    await expect(page.locator(".modal-box, .modal")).toHaveCount(0);

    const hh = await page.evaluate(() => getEmp(98101).hrHistory.find((x) => x.type === "discipline"));
    expect(hh.after).toBe("감봉");
    expect(hh.desc).toContain("지각 누적");

    // 인사카드 출력(window.open을 가로채 document.write 내용만 캡처)에 징계 이력이 포함되는지 확인.
    await page.evaluate(() => {
      window.__cardHtml = "";
      window.open = () => ({
        document: { write: (html) => { window.__cardHtml = html; }, close: () => {} },
        print: () => {}, close: () => {},
      });
    });
    await page.evaluate(() => printHRPersonnelCard(98101));
    const cardHtml = await page.evaluate(() => window.__cardHtml);
    expect(cardHtml).toContain("징계");
    expect(cardHtml).toContain("감봉");

    expect(pageErrors).toEqual([]);
  });

  test("계약직 계약 종료일이 임박하면 계약 관리 화면과 알림센터에 함께 노출된다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await loginAsAdmin(page);

    const soon = new Date(); soon.setDate(soon.getDate() + 20);
    const soonStr = soon.toISOString().slice(0, 10);
    await page.evaluate((endDate) => {
      employees.push({
        id: 98102, empNo: "E98102", name: "계약직원D1", dept: "경영지원본부", team: "인사팀",
        rank: "사원", position: "", active: true, hire: "2025-01-01", hrHistory: [], role: "member",
        contractType: "계약직", contractStart: "2025-01-01", contractEnd: endDate,
      });
    }, soonStr);

    await page.evaluate(() => gotoPage("contract-mgmt"));
    const row = page.locator("tr", { hasText: "계약직원D1" });
    await expect(row).toContainText("계약직");
    await expect(row).toContainText("D-20");

    await page.evaluate(() => gotoPage("notification-center"));
    await expect(page.locator("#content")).toContainText("계약 만료 임박");
    await expect(page.locator("#content")).toContainText("계약직원D1");

    expect(pageErrors).toEqual([]);
  });

  test("승진 시뮬레이션은 저장 없이 체크된 후보 기준으로 직급 분포를 미리 계산한다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await loginAsAdmin(page);

    await page.evaluate(() => {
      promotionSettings.evalYear = 2026;
      promotionSettings.minYearsByRank = { ...promotionSettings.minYearsByRank, "사원(대졸)": 0 };
      promotionSettings.excludeRanks = [];
      promotionSettings.eligibleGrades = ["S", "A"];
      promotionSettings.gradeYearRange = 3;
      promotionSettings.gradeCountRequired = 2;
      promotionSettings.legalEduRequired = false;
      employees.push({
        id: 98103, empNo: "E98103", name: "승진후보D1", dept: "경영지원본부", team: "인사팀",
        rank: "사원(대졸)", rankYear: 5, position: "", active: true, hire: "2020-01-01", hrHistory: [],
        role: "member", gradeResults: { "2024": { grade: "S" }, "2025": { grade: "A" } },
      });
    });

    await page.evaluate(() => gotoPage("promotion-mgmt"));
    await page.click("button:has-text('📊 승진 시뮬레이션')");
    await expect(page.locator(".modal-body")).toContainText("승진후보D1");

    const beforeAfter = await page.evaluate(() => {
      const ranks = orgDB.ranks || [];
      const idx = ranks.indexOf("사원(대졸)");
      return { ranks, idx };
    });
    expect(beforeAfter.idx).toBeGreaterThanOrEqual(0);

    // 기본값(적격자 자동 체크)으로 분포 변화(+1/-1 표시)가 먼저 나타남을 확인한다.
    const beforeUncheckText = await page.locator("#promo-sim-body").innerText();
    expect(beforeUncheckText).toMatch(/\(\+1\)/);

    // 체크 해제하면 변화가 사라진다(선택 해제 → 분포가 "현재"와 동일해짐).
    const checkbox = page.locator("#promo-sim-body tbody tr", { hasText: "승진후보D1" }).locator("input[type=checkbox]");
    await expect(checkbox).toBeChecked();
    await checkbox.uncheck();
    const afterUncheckText = await page.locator("#promo-sim-body").innerText();
    expect(afterUncheckText).not.toMatch(/\(\+1\)/);

    expect(pageErrors).toEqual([]);
  });

  test("직원 수정에서 권한을 변경하면 서버에 role_changed 로그가 남는다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await loginAsAdmin(page);

    await page.evaluate(() => {
      employees.push({
        id: 98104, empNo: "E98104", name: "권한변경D1", dept: "경영지원본부", team: "인사팀",
        rank: "사원", position: "", active: true, hire: "2022-01-01", hrHistory: [], role: "member",
      });
    });

    const logRequests = [];
    page.on("request", (req) => {
      if (req.method() === "POST" && req.url().includes("/log")) {
        try { logRequests.push(JSON.parse(req.postData())); } catch (e) {}
      }
    });

    await page.evaluate(() => openEmpEdit(98104));
    await page.waitForSelector("#ee-role");
    await page.selectOption("#ee-role", "leader");
    await page.click(".modal-foot button:has-text('저장')");
    await expect(page.locator(".modal-box, .modal")).toHaveCount(0);

    await expect.poll(() => logRequests.some((r) => r.action === "role_changed" && String(r.targetId).includes("98104"))).toBe(true);
    const roleLog = logRequests.find((r) => r.action === "role_changed");
    expect(roleLog.detail).toContain("→");

    expect(pageErrors).toEqual([]);
  });

  test("코드관리 허브는 마스터코드 현황을 요약하고 관리 화면으로 이동한다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await loginAsAdmin(page);

    const deptCount = await page.evaluate(() => orgDB.depts.length);
    await page.evaluate(() => gotoPage("code-mgmt"));
    await expect(page.locator("#content")).toContainText("부서");
    await expect(page.locator("#content")).toContainText(`${deptCount}`);

    await page.getByText("부서", { exact: true }).click();
    // 부서 카드를 눌렀으면 조직 관리(settings-org) 화면으로 이동해야 한다.
    const title = await page.locator("#page-title").innerText();
    expect(title).toBe("조직 관리");

    expect(pageErrors).toEqual([]);
  });
});
