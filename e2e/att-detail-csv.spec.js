const { test, expect } = require("@playwright/test");

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

// 근태 상세 CSV가 자체 구현 대신 공용 dlCSV(따옴표 감싸기 + 수식 주입 무력화)를 쓰는지 확인한다.
test("근태 상세 CSV는 공용 dlCSV로 내려가고 자유텍스트가 안전하게 처리된다", async ({ page }) => {
  await loginAsAdmin(page);
  const result = await page.evaluate(() => {
    employees.push({ id: 9701, empNo: "E9701", name: "근태CSV대상", dept: "개발본부", team: "A1팀", rank: "대리", position: "", active: true, hire: "2020-01-01", hrHistory: [], role: "member" });
    _attInitDates();
    const ym = _attState.dateFrom;
    attendanceRecords.push({ id: 9701001, empId: 9701, date: ym + "-02", checkIn: "09:00", checkOut: "18:30", status: "normal", note: "=cmd|'/c calc'!A1, 콤마" });
    window.__csvCalls = [];
    dlCSV = async (fn, headers, rows) => { window.__csvCalls.push({ fn, headers, rows }); };
    downloadAttDetailCSV(9701);
    return window.__csvCalls;
  });
  expect(result).toHaveLength(1);
  expect(result[0].fn).toMatch(/^근태_근태CSV대상_.*\.csv$/);
  expect(result[0].headers).toEqual(["날짜", "출근시간", "퇴근시간", "근무시간(h)", "상태", "비고"]);
  expect(result[0].rows[0].slice(1, 5)).toEqual(["09:00", "18:30", 9.5, "정상"]);
  // 실제 셀 가공은 dlCSV 안에서 일어나므로, 원본 dlCSV 로직으로 직접 확인
  const cell = await page.evaluate(() => _csvSafeCell("=cmd|'/c calc'!A1, 콤마"));
  expect(cell.startsWith("'=")).toBe(true);
});
