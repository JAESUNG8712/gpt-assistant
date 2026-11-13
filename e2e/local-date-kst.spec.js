const { test, expect } = require("@playwright/test");

// 한국 시간 00~09시에는 UTC 날짜가 하루 전이라, toISOString() 기반 "오늘"이 어제로 나오던 문제의 회귀 테스트.
// 시스템 시각을 UTC 2026-11-12 20:00(=KST 2026-11-13 05:00)로 고정하고 브라우저 시간대를 Asia/Seoul로 맞춘다.
test.use({ timezoneId: "Asia/Seoul" });

test("한국 새벽 시간에도 '오늘'이 KST 날짜로 계산된다", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-11-12T20:00:00Z"));
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

  const r = await page.evaluate(() => ({
    today: _localDateStr(),
    utcToday: new Date().toISOString().slice(0, 10),
    // 오늘(KST)부터 시작하는 휴직은 오늘 휴직 중이어야 한다.
    onLeave: _isOnLeave({ leaves: [{ start: "2026-11-13", end: "2026-11-30" }] }),
    plus7: _localDateStr(new Date(Date.now() + 7 * 86400000)),
  }));
  expect(r.utcToday).toBe("2026-11-12"); // 수정 전 방식은 하루 전
  expect(r.today).toBe("2026-11-13");
  expect(r.onLeave).toBe(true);
  expect(r.plus7).toBe("2026-11-20");
});

test("한국 시간대에서 주간·월간 날짜 배열과 기간 기본값이 하루씩 밀리지 않는다", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-11-12T20:00:00Z")); // KST 2026-11-13(금) 05:00
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

  const r = await page.evaluate(() => ({
    week: _roomWeekDates("2026-11-13"),
    month: _roomMonthDates("2026-11-13").days.map(_localDateStr).slice(0, 3),
    recur: _roomRecurDates("2026-11-09", "weekday", "2026-11-09", "2026-11-13", [1, 3]),
    costFrom: _costStmtFrom,
  }));
  expect(r.week).toEqual(["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15"]);
  expect(r.month[0]).toBe("2026-10-26"); // 11월 달력 그리드는 월요일(10/26)부터
  expect(r.recur).toEqual(["2026-11-09", "2026-11-11"]);
  expect(r.costFrom).toBe("2026-01-01"); // 수정 전에는 2025-12-31
});
