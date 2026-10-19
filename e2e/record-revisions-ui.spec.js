const { test, expect } = require("@playwright/test");

async function loginAsAdmin(page) {
  await page.goto("/");
  await page.fill("#l-id", "e2e_admin");
  await page.fill("#l-pw", "E2eTestPw123");
  await page.evaluate(() => { autoSaveDebounced = () => {}; loadFromServer = async () => {}; connectSSE = async () => {}; });
  await page.click(".login-card button.btn-primary");
  await expect(page.locator("#main")).toBeVisible({ timeout: 10000 });
}

test("수정 이력 화면에서 삭제·수정된 항목을 확인하고 복구를 요청한다", async ({ page }) => {
  await loginAsAdmin(page);
  await page.evaluate(() => {
    window.__calls = [];
    serverConfig.enabled = true; serverConfig.url = location.origin;
    serverRequest = async (method, path, body) => {
      window.__calls.push({ method, path });
      if (path.startsWith("/api/record-revisions?")) return { ok: true, revisions: [
        { id: "rev-1", field: "boardPosts", recordId: "p1", operation: "delete", title: "<b>지운 글</b>", changedBy: "auth:admin", changedAt: new Date().toISOString() },
        { id: "rev-2", field: "okrObjectives", recordId: "o1", operation: "update", title: "목표", changedBy: "auth:admin", changedAt: new Date().toISOString() }] };
      return { ok: true, existed: false };
    };
    gotoPage("history");
  });
  const panel = page.locator("#rev-panel");
  await expect(panel).toContainText("삭제됨");
  await expect(panel).toContainText("수정됨");
  await expect(panel.locator("b")).toHaveCount(0); // 제목은 이스케이프된다
  await panel.getByRole("button", { name: "되살리기" }).click();
  await page.locator(".modal-ov").getByRole("button", { name: "복구" }).click();
  await expect.poll(() => page.evaluate(() => window.__calls.some(c => c.method === "POST" && c.path.endsWith("/rev-1/restore")))).toBe(true);
});
