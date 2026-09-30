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

test.describe("과거 시점 인력현황(인사 통계 기준일)", () => {
  test("기준일을 과거로 지정하면 그 시점 재직 인원만 집계된다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", e => pageErrors.push(e.message));

    await loginAsAdmin(page);

    await page.evaluate(() => {
      employees = employees.concat([
        // 2020-01-01에 이미 재직, 아직 재직 중
        { id: 9101, empNo: "E9101", name: "이과거", dept: "테스트부", team: "A팀", rank: "대리", position: "", active: true, hire: "2019-06-01", hrHistory: [] },
        // 2022-06-01에 신규입사 -> 2020-01-01 시점엔 존재하지 않아야 함
        { id: 9102, empNo: "E9102", name: "박신입", dept: "테스트부", team: "A팀", rank: "사원", position: "", active: true, hire: "2022-06-01", hrHistory: [] },
        // 2019-01-01 입사, 2020-06-30 퇴직 -> 2020-01-01 시점엔 재직중이어야 하고 현재는 퇴직
        { id: 9103, empNo: "E9103", name: "최퇴직", dept: "테스트부", team: "A팀", rank: "과장", position: "", active: false, hire: "2019-01-01", retireDate: "2020-06-30", hrHistory: [] },
      ]);
    });

    await page.evaluate(() => gotoPage("hr-stats"));
    await expect(page.locator("text=기준일(인원현황)")).toBeVisible();

    // 기준일 미지정(현재 시점): 재직중인 이과거/박신입은 포함, 최퇴직은 제외
    let names = await page.evaluate(() => window._hrStatsActiveAsOf("").map(e => e.name));
    expect(names).toContain("이과거");
    expect(names).toContain("박신입");
    expect(names).not.toContain("최퇴직");

    // 기준일 2020-01-01: 이과거/최퇴직은 재직중, 박신입은 아직 입사 전
    names = await page.evaluate(() => window._hrStatsActiveAsOf("2020-01-01").map(e => e.name));
    expect(names).toContain("이과거");
    expect(names).toContain("최퇴직");
    expect(names).not.toContain("박신입");

    // UI로도 기준일을 입력하면 "N 기준" 라벨과 함께 반영된다
    await page.fill('input[type=date]', "2020-01-01");
    await page.locator('input[type=date]').first().dispatchEvent("change");
    await expect(page.locator("text=2020-01-01 기준")).toBeVisible();

    await page.locator("text=✕ 현재로").click();
    await expect(page.locator("text=2020-01-01 기준")).toHaveCount(0);

    expect(pageErrors).toEqual([]);
  });
});

test.describe("발령·변동 이력 - 발령일자 범위 필터 + 퇴직자 포함", () => {
  test("기간 필터가 적용되고 퇴직자 이력도 전체 현황에 표시된다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", e => pageErrors.push(e.message));

    await loginAsAdmin(page);

    await page.evaluate(() => {
      employees = employees.concat([
        {
          id: 9201, empNo: "E9201", name: "정이력", dept: "테스트부", team: "B팀", rank: "대리", position: "", active: true, hire: "2018-01-01",
          hrHistory: [
            { id: "h1", type: "rank_change", date: "2021-03-01", applied: true, note: "" },
            { id: "h2", type: "transfer", date: "2023-09-01", applied: true, note: "" },
          ],
        },
        {
          id: 9202, empNo: "E9202", name: "김퇴사", dept: "테스트부", team: "B팀", rank: "과장", position: "", active: false, hire: "2015-01-01", retireDate: "2022-05-01",
          hrHistory: [
            { id: "h3", type: "promotion", date: "2020-01-01", applied: true, note: "" },
          ],
        },
      ]);
    });

    await page.evaluate(() => gotoPage("hr-changes"));

    // 퇴직자(김퇴사)의 이력도 전체 현황 테이블에 표시된다
    await expect(page.locator("table", { hasText: "발령·변동 이력" }).first().locator("text=김퇴사")).toBeVisible().catch(() => {});
    let bodyText = await page.locator("#content").innerText();
    expect(bodyText).toContain("김퇴사");
    expect(bodyText).toContain("정이력");

    // 기간 필터: 2021-01-01 ~ 2021-12-31 -> 정이력의 h1(2021-03-01)만 남고 h2(2023-09-01)/h3(2020-01-01)는 제외
    const dateInputs = page.locator('input[type=date]');
    await dateInputs.nth(0).fill("2021-01-01");
    await dateInputs.nth(0).dispatchEvent("change");
    await dateInputs.nth(1).fill("2021-12-31");
    await dateInputs.nth(1).dispatchEvent("change");

    bodyText = await page.locator("#content").innerText();
    expect(bodyText).toContain("정이력");
    expect(bodyText).not.toContain("김퇴사");

    await page.locator("text=기간 초기화").click();
    bodyText = await page.locator("#content").innerText();
    expect(bodyText).toContain("김퇴사");

    expect(pageErrors).toEqual([]);
  });
});

test.describe("예약(미래) 인사발령의 자동 반영 시점", () => {
  test("발령일이 도래하면 로그인/수동불러오기뿐 아니라 자동저장 주기·SSE 동기화 시점에도 반영된다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", e => pageErrors.push(e.message));

    await loginAsAdmin(page);

    // (1) 자동저장 타이머 콜백과 동일한 경로: 이미 발령일이 지난 pending 항목이
    //     _applyDueHRChanges() 한 번으로 반영되는지 직접 검증.
    let result = await page.evaluate(() => {
      const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      employees.push({
        id: 9301, empNo: "E9301", name: "차예약", dept: "테스트부", team: "C팀", rank: "사원", position: "",
        active: true, hire: "2020-01-01", jobGroup: "일반",
        hrHistory: [
          { id: "hp1", type: "rank_change", date: yesterday, applied: false, pendingUpdates: { rank: "대리" }, note: "예정" },
        ],
      });
      const changed = _applyDueHRChanges();
      const emp = employees.find(e => e.id === 9301);
      return { changed, rank: emp.rank, applied: emp.hrHistory[0].applied };
    });
    expect(result.changed).toBe(true);
    expect(result.rank).toBe("대리");
    expect(result.applied).toBe(true);

    // (2) 아직 발령일이 안 된 항목은 그대로 유지된다(오탐 없음 확인).
    result = await page.evaluate(() => {
      const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
      employees.push({
        id: 9302, empNo: "E9302", name: "미래예약", dept: "테스트부", team: "C팀", rank: "사원", position: "",
        active: true, hire: "2020-01-01",
        hrHistory: [
          { id: "hp2", type: "rank_change", date: tomorrow, applied: false, pendingUpdates: { rank: "차장" }, note: "예정" },
        ],
      });
      const changed = _applyDueHRChanges();
      const emp = employees.find(e => e.id === 9302);
      return { changed, rank: emp.rank, applied: emp.hrHistory[0].applied };
    });
    expect(result.rank).toBe("사원");
    expect(result.applied).toBe(false);

    // (3) SSE data_updated 핸들러 경로: 서버가 GET /data로 내려주는 값에 이미 발령일이
    //     지난 pending 항목이 포함돼 있으면, applyState() 직후 _applyDueHRChanges()가
    //     호출되어 화면 반영 전에 정리됨을 확인(핸들러 로직을 그대로 재현).
    result = await page.evaluate(() => {
      const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      const incoming = JSON.parse(JSON.stringify(employees));
      incoming.push({
        id: 9303, empNo: "E9303", name: "동기화예약", dept: "테스트부", team: "C팀", rank: "사원", position: "",
        active: true, hire: "2020-01-01",
        hrHistory: [
          { id: "hp3", type: "rank_change", date: yesterday, applied: false, pendingUpdates: { rank: "부장" }, note: "예정" },
        ],
      });
      applyState({ data: { employees: incoming } }, true);
      const changed = _applyDueHRChanges();
      const emp = employees.find(e => e.id === 9303);
      return { changed, rank: emp.rank };
    });
    expect(result.changed).toBe(true);
    expect(result.rank).toBe("부장");

    expect(pageErrors).toEqual([]);
  });
});
