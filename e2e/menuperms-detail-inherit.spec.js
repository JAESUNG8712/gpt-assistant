const { test, expect } = require("@playwright/test");

// 사이드바에 직접 없는 편집·상세 화면은 부모 메뉴를 menuPerms로 끈 사용자에게도 막혀야 한다.
const CASES = [
  ["comp-evaluator-setup", "comp-eval"],
  ["engagement-pulse-create", "engagement-pulse"],
  ["engagement-pulse-action-new", "engagement-pulse"],
  ["engagement-pulse-action-detail", "engagement-pulse"],
  ["acct-fixed-assets-detail", "acct-fixed-assets"],
  ["acct-rcps-detail", "acct-rcps"],
  ["recruit-eval-detail", "recruit-eval"],
];

test("부모 메뉴를 끄면 하위 상세·편집 화면 직접 이동도 접근 거부된다", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", e => pageErrors.push(e.message));
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

  const result = await page.evaluate((cases) => {
    const out = {};
    let denied = 0;
    const orig = _pageAccessDenied;
    _pageAccessDenied = () => { denied++; };
    const run = (id) => { denied = 0; try { gotoPage(id); } catch (e) { return "error:" + e.message; } return denied; };
    // 대조군: 아무것도 끄지 않았을 때는 거부되지 않아야 한다.
    currentUser.menuPerms = {};
    for (const [route] of cases) out["open:" + route] = run(route);
    for (const [route, parent] of cases) {
      currentUser.menuPerms = { [parent]: false };
      out["blocked:" + route] = run(route);
    }
    currentUser.menuPerms = {};
    _pageAccessDenied = orig;
    return out;
  }, CASES);

  for (const [route] of CASES) {
    expect(result["open:" + route], route + " 대조군").toBe(0);
    expect(result["blocked:" + route], route + " 차단").toBe(1);
  }
  expect(pageErrors).toEqual([]);
});
