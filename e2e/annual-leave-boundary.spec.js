const { test, expect } = require("@playwright/test");

// 연차 발생(calcAnnualLeaveGrant)이 365.25일 근사 대신 달력 기준 완료 연/월을 쓰는지 확인한다.
// 입사 1주년 전날은 아직 1년 미만(월차 최대 11일), 당일부터 15일이다. 날짜는 실행일 기준으로
// 동적 계산한다(하드코딩 날짜는 시간이 지나면 깨진다).
test("연차 발생이 입사 1주년 경계를 달력 기준으로 판정한다", async ({ page }) => {
  await page.goto("/");
  const r = await page.evaluate(() => {
    const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T00:00:00`;
    const now = new Date();
    const mk = (y, m, d) => { const x = new Date(now.getFullYear() - y, now.getMonth() - m, now.getDate() + d); return fmt(x); };
    return {
      dayBeforeFirstAnniv: calcAnnualLeaveGrant({ hire: mk(1, 0, 1) }),
      firstAnniv: calcAnnualLeaveGrant({ hire: mk(1, 0, 0) }),
      dayBeforeOneMonth: calcAnnualLeaveGrant({ hire: mk(0, 1, 1) }),
      oneMonth: calcAnnualLeaveGrant({ hire: mk(0, 1, 0) }),
      today: calcAnnualLeaveGrant({ hire: mk(0, 0, 0) }),
    };
  });
  expect(r.dayBeforeFirstAnniv).toBe(11);
  expect(r.firstAnniv).toBe(15);
  expect(r.dayBeforeOneMonth).toBe(0);
  expect(r.oneMonth).toBe(1);
  expect(r.today).toBe(0);
});
