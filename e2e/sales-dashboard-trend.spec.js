const { test, expect } = require("@playwright/test");

// 영업 대시보드 "월별 추이" 탭 — 서버 집계 숫자 자체는 test/api-sales-dashboard-trend.test.js가
// 검증하고, 여기서는 화면이 그 응답을 차트·표·증감률로 올바르게 그리는지와 연도 선택이
// 서버에 ?year= 로 다시 요청하는지를 확인한다.
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

test("월별 추이 탭: 차트·표·전년 대비를 그리고, 연도를 바꾸면 ?year= 로 다시 조회한다", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await loginAsAdmin(page);

  const months = (rev, prev) => Array.from({ length: 12 }, (_, i) => ({
    month: i + 1, count: rev[i] ? 1 : 0, orderCount: rev[i] ? 1 : 0, order: rev[i], revenue: rev[i],
    prevOrder: prev[i], prevRevenue: prev[i],
    revenueGrowthPct: prev[i] > 0 ? Math.round(((rev[i] - prev[i]) / prev[i]) * 100) : null,
  }));
  const rev = [0, 0, 150000, 0, 0, 40000, 0, 0, 0, 0, 0, 0];
  const prev = [0, 0, 100000, 0, 0, 0, 0, 0, 0, 0, 0, 0];

  const requested = [];
  await page.route("**/api/erp/sales-dashboard**", (route) => {
    requested.push(new URL(route.request().url()).search);
    const sp = new URL(route.request().url()).searchParams;
    const year = Number(sp.get("year")) || 2031;
    const rep = sp.get("rep") || "";
    route.fulfill({ json: {
      ok: true, targetsByYear: {}, partnerRanking: [], pipeline: [], repRanking: [],
      monthlyTrend: { year, rep, reps: ['김영업', '이영업<b>'], years: [2031, 2030], months: months(rep ? rev.map(v => v / 2) : rev, prev) },
    } });
  });

  await page.evaluate(() => gotoPage("sales-dashboard"));
  await page.locator(".tab-btn", { hasText: "월별 추이" }).click();

  // 차트(SVG)와 12개월 표
  await expect(page.locator("svg[aria-label='월별 매출 추이 막대 차트']")).toBeVisible();
  await expect(page.locator("#sales-dash-body tbody tr")).toHaveCount(12);
  // 3월: 150,000 vs 전년 100,000 → +50%(초록), 6월: 전년 0 → "-"
  const mar = page.locator("#sales-dash-body tbody tr").nth(2);
  await expect(mar).toContainText("150,000");
  await expect(mar).toContainText("+50%");
  await expect(page.locator("#sales-dash-body tbody tr").nth(5)).toContainText("-");
  // 요약: 올해 매출 190,000 / 전년 100,000 → +90%
  await expect(page.locator("#sales-dash-body")).toContainText("190,000");
  await expect(page.locator("#sales-dash-body")).toContainText("+90%");

  // 연도 변경 → 서버에 ?year=2030 으로 재요청
  await page.locator("#sales-dash-body select").first().selectOption("2030");
  await expect.poll(() => requested.some((q) => q.includes("year=2030"))).toBe(true);
  await expect(page.locator("#sales-dash-body select").first()).toHaveValue("2030");

  // 담당자 필터 → ?rep= 로 재요청, 이름은 이스케이프되어 태그로 해석되지 않음
  const repSel = page.locator("#sales-trend-rep");
  await expect(repSel.locator("option")).toHaveCount(3); // 전체 + 2명
  await expect(repSel.locator("option b")).toHaveCount(0);
  await repSel.selectOption("이영업<b>");
  await expect.poll(() => requested.some((q) => q.includes("rep=" + encodeURIComponent("이영업<b>")))).toBe(true);
  await expect(page.locator("#sales-trend-rep")).toHaveValue("이영업<b>");
  await expect(page.locator("#sales-dash-body")).toContainText("담당자 필터는 전년 비교에도 같이 적용됩니다");
  // 수주 건수 열
  await expect(page.locator("#sales-dash-body thead")).toContainText("수주 건수");

  expect(pageErrors).toEqual([]);
});
