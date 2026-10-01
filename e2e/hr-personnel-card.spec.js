const { test, expect } = require("@playwright/test");

async function loginAsAdmin(page) {
  await page.goto("/");
  await page.fill("#l-id", "e2e_admin");
  await page.fill("#l-pw", "E2eTestPw123");
  // 로그인 직후 백그라운드 서버 재동기화(SSE/자동로드)가 테스트가 시딩한
  // 순수 인메모리 상태를 덮어쓰는 경합을 막는다(이 프로젝트의 확립된 관례).
  await page.evaluate(() => {
    autoSaveDebounced = () => {};
    loadFromServer = async () => {};
    connectSSE = async () => {};
  });
  await page.click(".login-card button.btn-primary");
  await expect(page.locator("#main")).toBeVisible({ timeout: 10000 });
}

// window.open()이 실제 팝업을 띄우는 대신, document.write()로 넘어온 HTML
// 문자열을 가로채 검증할 수 있도록 가짜 창 객체로 교체한다(print/close는 no-op).
async function captureNextPrintWindow(page) {
  await page.evaluate(() => {
    window.__lastPrintHtml = null;
    window.__realOpen = window.open;
    window.open = function () {
      const fakeDoc = {
        write(html) { window.__lastPrintHtml = html; },
        close() {},
      };
      return { document: fakeDoc, print() {}, close() {} };
    };
  });
}

test.describe("인사카드 출력 기능", () => {
  test("권한자는 비공개 항목까지, 비권한자는 공개 항목만 인쇄 문서에 포함된다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));

    await loginAsAdmin(page);

    await page.evaluate(() => {
      employees.push({
        id: 9401, empNo: "E9401", name: "카드검증", dept: "테스트부", team: "D팀",
        rank: "과장", position: "팀장", active: true, hire: "2018-03-02",
        birth: "1985-07-10", gender: "남", nationality: "내국인", edu: "학사",
        eduSchool: "테스트대학교", totalCareer: 3, address: "서울시 강남구",
        phone: "010-1234-5678", email: "card@example.com",
        careers: [{ co: "이전회사", pos: "대리", start: "2015-01-01", end: "2018-02-28", desc: "영업" }],
        hrHistory: [
          { id: "hc-1", type: "promotion", date: "2021-01-01", applied: true, desc: "승진", before: "대리", after: "과장" },
          { id: "hc-2", type: "edu_general", date: "2022-05-01", desc: "직무교육", institution: "사내교육원" },
        ],
        leaves: [{ type: "육아휴직", start: "2020-01-01", end: "2020-06-30", note: "육아" }],
      });
    });

    // 권한자(admin) — 비공개 항목까지 포함
    await captureNextPrintWindow(page);
    await page.evaluate(() => printHRPersonnelCard(9401));
    let html = await page.evaluate(() => window.__lastPrintHtml);
    expect(html).toContain("카드검증");
    expect(html).toContain("1985-07-10"); // 생년월일(비공개)
    expect(html).toContain("서울시 강남구"); // 주소(비공개)
    expect(html).toContain("이전회사"); // 과거 경력
    expect(html).toContain("사내교육원"); // 교육 이수 이력
    expect(html).toContain("육아휴직"); // 휴직 이력
    expect(html).toContain("승진"); // 인사 발령 이력

    // 비권한자(hrPrivateViewers 미등록, member) — 공개 항목만
    await page.evaluate(() => {
      currentUser = { id: 9998, name: "일반직원", role: "member" };
      settings.hrPrivateViewers = [];
    });
    await captureNextPrintWindow(page);
    await page.evaluate(() => printHRPersonnelCard(9401));
    html = await page.evaluate(() => window.__lastPrintHtml);
    expect(html).toContain("카드검증");
    expect(html).not.toContain("1985-07-10");
    expect(html).not.toContain("서울시 강남구");
    expect(html).not.toContain("이전회사");
    expect(html).not.toContain("사내교육원");
    expect(html).not.toContain("육아휴직");

    expect(pageErrors).toEqual([]);
  });

  test("직원 상세 모달에 인사카드 출력 버튼이 노출되고 클릭 시 인쇄 창이 열린다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));

    await loginAsAdmin(page);

    await page.evaluate(() => {
      employees.push({
        id: 9402, empNo: "E9402", name: "버튼검증", dept: "테스트부", team: "D팀",
        rank: "사원", position: "", active: true, hire: "2023-01-01", hrHistory: [],
      });
    });

    await page.evaluate(() => gotoPage("hr-list"));
    await captureNextPrintWindow(page);
    await page.evaluate(() => openEmpDetail(9402));
    await expect(page.locator("text=🪪 인사카드 출력")).toBeVisible();
    await page.locator("text=🪪 인사카드 출력").click();
    const html = await page.evaluate(() => window.__lastPrintHtml);
    expect(html).toContain("버튼검증");
    expect(html).toContain("인 사 카 드");

    expect(pageErrors).toEqual([]);
  });
});
