const { test, expect } = require("@playwright/test");

// 장기근속 포상금 급여 연동 — 대상자 행에서 한 번 클릭으로 급여 조정(payrollAdjustments)을 만들고,
// 같은 포상의 중복 반영·마감/확정 월 반영·휴직자·포상금 미설정 기준을 막는지 확인한다.
// 입사일은 실행일 기준으로 계산해 날짜가 지나도 영구히 "만 5년을 막 채운 직원"이 된다.
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

const seed = () => {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 5);
  d.setDate(d.getDate() - 10);
  const hire = d.toISOString().slice(0, 10); // 만 5년 + 10일 경과
  const base = { dept: "근속부", team: "근속팀", role: "member", active: true, hire, salary: 48000000, menuPerms: {} };
  employees.push(
    { ...base, id: 9801, name: "근속대상" },
    { ...base, id: 9802, name: "근속휴직", leaves: [{ start: "2000-01-01", end: "2999-12-31", type: "휴직" }] },
  );
  settings.longServiceAwards = [
    { years: 5, reward: "포상금 50만원 + 휴가 2일", amount: 500000 },
    { years: 10, reward: "기념패만", amount: 0 },
  ];
};

test.describe("장기근속 포상금 급여 연동", () => {
  test("반영 → 중복 방지 → 취소 흐름과 급여 명세서 금액 반영", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await loginAsAdmin(page);
    await page.evaluate(`(${seed.toString()})()`);
    await page.evaluate(() => gotoPage("long-service-award"));

    const row = page.locator("#content tbody tr", { hasText: "근속대상" });
    await expect(row).toContainText("500,000원 반영");

    // 반영 전 급여 조정액
    const before = await page.evaluate(() => calcStandardPayslip(getEmp(9801), new Date().getFullYear(), new Date().getMonth() + 1).adjustPay || 0);

    await row.locator("button", { hasText: "500,000원 반영" }).click();
    const modal = page.locator(".modal-box", { hasText: "장기근속 포상금 급여 반영" });
    await expect(modal).toBeVisible();
    await modal.locator("button", { hasText: "급여에 반영" }).click();

    const rec = await page.evaluate(() => payrollAdjustments.filter((a) => a.sourceKey === "longservice-9801-5"));
    expect(rec).toHaveLength(1);
    expect(rec[0]).toMatchObject({ id: "payadj-longservice-9801-5", empId: 9801, amount: 500000, category: "장기근속 포상금", source: "longservice_award", taxable: true });

    // 같은 달 명세서에 포상금이 그대로 더해진다
    const after = await page.evaluate((r) => calcStandardPayslip(getEmp(9801), r.year, r.month).adjustPay || 0, rec[0]);
    expect(after - (rec[0].year === new Date().getFullYear() && rec[0].month === new Date().getMonth() + 1 ? before : 0)).toBe(500000);

    // 행은 반영 완료 배지 + 취소 버튼으로 바뀐다
    await expect(row).toContainText("급여 500,000원");
    await expect(row.locator("button", { hasText: "취소" })).toBeVisible();
    await expect(row.locator("button", { hasText: "500,000원 반영" })).toHaveCount(0);

    // 중복 반영 시도(API 직접 호출)는 새 레코드를 만들지 않는다
    await page.evaluate(() => { openLongServicePayoutModal(9801, 5); });
    await page.evaluate(() => applyLongServicePayout("9801", 5));
    expect(await page.evaluate(() => payrollAdjustments.filter((a) => a.sourceKey === "longservice-9801-5").length)).toBe(1);

    // 취소하면 급여 조정이 사라지고 다시 반영 버튼이 나온다
    await row.locator("button", { hasText: "취소" }).click();
    await page.locator("section.modal", { hasText: "장기근속 포상금 반영 취소" }).locator("button", { hasText: "반영 취소" }).click();
    await expect(row.locator("button", { hasText: "500,000원 반영" })).toBeVisible();
    expect(await page.evaluate(() => payrollAdjustments.filter((a) => a.sourceKey === "longservice-9801-5").length)).toBe(0);
    expect(pageErrors).toEqual([]);
  });

  test("휴직자는 반영 버튼이 없고, 포상금 미설정 기준은 안내만 표시하며, 확정된 월은 선택할 수 없다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await loginAsAdmin(page);
    await page.evaluate(`(${seed.toString()})()`);

    // 현재 달 명세서를 확정 상태로 만든다
    await page.evaluate(() => {
      const y = new Date().getFullYear(), m = new Date().getMonth() + 1;
      payslips.push({ ...calcStandardPayslip(getEmp(9801), y, m), confirmed: true });
    });
    await page.evaluate(() => gotoPage("long-service-award"));

    const leaveRow = page.locator("#content tbody tr", { hasText: "근속휴직" });
    await expect(leaveRow).toContainText("휴직");
    await expect(leaveRow.locator("button", { hasText: "반영" })).toHaveCount(0);

    const row = page.locator("#content tbody tr", { hasText: "근속대상" });
    await row.locator("button", { hasText: "500,000원 반영" }).click();
    const modal = page.locator(".modal-box", { hasText: "장기근속 포상금 급여 반영" });
    // 확정된 현재 월 옵션은 비활성화된다
    const first = modal.locator("#lsp-month option").first();
    await expect(first).toBeDisabled();
    await expect(first).toContainText("명세서가 확정된 월");
    expect(await page.evaluate(() => payrollAdjustments.some((a) => a.source === "longservice_award"))).toBe(false);

    // 포상금 미설정 기준(10년, amount 0)은 반영 대상이 아니다
    const msg = await page.evaluate(() => { openLongServicePayoutModal(9801, 10); return document.querySelector(".toast")?.textContent || ""; });
    expect(msg).toContain("포상금이 설정된 기준이 아닙니다");
    expect(pageErrors).toEqual([]);
  });

  test("비관리자는 화면에 접근할 수 없고 함수를 직접 호출해도 아무것도 만들지 않는다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await loginAsAdmin(page);
    await page.evaluate(`(${seed.toString()})()`);
    await page.evaluate(() => {
      currentUser = { ...currentUser, role: "director", dept: "근속부" };
      gotoPage("long-service-award");
    });
    await expect(page.locator("#content")).toContainText("접근 권한이 없습니다");
    await page.evaluate(() => { applyLongServicePayout("9801", 5); openLongServicePayoutModal(9801, 5); cancelLongServicePayout("9801", 5); });
    expect(await page.evaluate(() => payrollAdjustments.some((a) => a.source === "longservice_award"))).toBe(false);
    await expect(page.locator(".modal-box", { hasText: "장기근속 포상금 급여 반영" })).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  });

  test("복지 제도 설정에서 포상금(원)을 입력·저장하고 음수는 0으로 보정한다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await loginAsAdmin(page);
    await page.evaluate(`(${seed.toString()})()`);
    await page.evaluate(() => gotoPage("welfare-settings"));
    await page.locator(".tab-btn", { hasText: "장기근속" }).click();
    await expect(page.locator("#welfare-settings-content")).toContainText("급여 반영 포상금(원)");

    const inputs = page.locator("#welfare-settings-content tbody input[type=number]");
    // 5년 기준은 기존 포상금 500,000, 10년 기준은 비어 있음(0)
    await expect(inputs.nth(1)).toHaveValue("500000");
    await expect(inputs.nth(3)).toHaveValue("");
    await inputs.nth(3).fill("1200000");
    await inputs.nth(1).fill("-500");
    const amounts = await page.evaluate(() => settings.longServiceAwards.map((t) => t.amount));
    expect(amounts).toEqual([0, 1200000]);
    expect(pageErrors).toEqual([]);
  });
});
