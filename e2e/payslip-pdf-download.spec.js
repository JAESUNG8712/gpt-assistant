const { test, expect } = require("@playwright/test");
const fs = require("fs");

// 급여 명세서 PDF 다운로드 — 화면의 "📄 PDF" 버튼이 호출하는 downloadPayslipPdf()가
// 서버에서 실제 PDF를 받아 파일로 저장하는지 브라우저에서 확인한다.
// PDF 내용(한글·금액)은 test/api-payslip-pdf.test.js가 검증하므로 여기서는 파일 저장 경로만 본다.

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

test.describe("급여 명세서 PDF 다운로드", () => {
  test("PDF 버튼 호출이 서버 PDF를 파일로 저장한다", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await loginAsAdmin(page);

    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 15000 }),
      page.evaluate(() => downloadPayslipPdf(currentUser.id, 2026, 5)),
    ]);
    expect(download.suggestedFilename()).toMatch(/^payslip_2026-05_[A-Za-z0-9_-]+\.pdf$/);
    const buf = fs.readFileSync(await download.path());
    expect(buf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(pageErrors).toEqual([]);
  });

  test("서버 오류 메시지는 토스트로 보여주고 파일은 만들지 않는다", async ({ page }) => {
    await loginAsAdmin(page);
    let downloaded = false;
    page.on("download", () => { downloaded = true; });
    // 존재하지 않는 직원 id → 서버 404 메시지가 토스트로 나와야 한다
    await page.evaluate(() => downloadPayslipPdf("no-such-employee", 2026, 5));
    await expect(page.locator(".toast").last()).toContainText("직원 정보를 찾을 수 없습니다", { timeout: 10000 });
    await page.waitForTimeout(300);
    expect(downloaded).toBe(false);
  });
});
