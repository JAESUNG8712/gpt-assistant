const { test, expect } = require("@playwright/test");

async function loginAsAdmin(page) {
  await page.goto("/");
  await page.fill("#l-id", "e2e_admin");
  await page.fill("#l-pw", "E2eTestPw123");
  await page.evaluate(() => { autoSaveDebounced = () => {}; loadFromServer = async () => {}; connectSSE = async () => {}; });
  await page.click(".login-card button.btn-primary");
  await expect(page.locator("#main")).toBeVisible({ timeout: 10000 });
}

test("대기 중인 웹훅 요청은 새로고침 후에도 복원되어 서버에 다시 요청된다", async ({ page }) => {
  await loginAsAdmin(page);
  const result = await page.evaluate(async () => {
    const calls = [];
    serverConfig.enabled = true; serverConfig.url = location.origin;
    const original = serverRequest;
    serverRequest = async (method, path, body) => { calls.push({ method, path, body }); return { ok: true, dispatched: 1 }; };
    try {
      _fireIntegrationWebhooks("approval_request", "doc-1"); // 저장 전 대기 상태로 localStorage에 남는다
      const stored = JSON.parse(localStorage.getItem(_pendingWebhookStorageKey()) || "[]");
      _pendingIntegrationWebhooks.length = 0; // 탭을 닫아 메모리 대기열이 사라진 상황
      _restorePendingIntegrationWebhooks();
      await new Promise(r => setTimeout(r, 200));
      return { stored, calls, left: localStorage.getItem(_pendingWebhookStorageKey()) };
    } finally { serverRequest = original; }
  });
  expect(result.stored).toHaveLength(1);
  expect(result.calls.some(c => c.path === "/api/integrations/webhooks/dispatch" && c.body.recordId === "doc-1")).toBe(true);
  expect(result.left).toBeNull(); // 접수되면 저장소에서 제거
});

test("연동 설정의 발송 대기함이 상태를 보여주고 다시 보내기를 요청한다", async ({ page }) => {
  await loginAsAdmin(page);
  const calls = await page.evaluate(async () => {
    const calls = (window.__whCalls = []);
    serverConfig.enabled = true; serverConfig.url = location.origin;
    serverRequest = async (method, path) => {
      calls.push({ method, path });
      if (path.endsWith("/outbox")) return { ok: true, summary: { pending: 0, sent: 0, dead: 1, cancelled: 0 }, entries: [
        { id: "whob-1", eventLabel: "결재 요청 발생", webhookName: "<b>슬랙</b>", text: "x", status: "dead", attempts: 6, nextAttemptAt: new Date().toISOString(), lastError: "HTTP 500", createdAt: new Date().toISOString() }] };
      return { ok: true };
    };
    gotoPage("integrations");
    await new Promise(r => setTimeout(r, 400));
    return calls;
  });
  expect(calls.some(c => c.path.endsWith("/outbox"))).toBe(true);
  const panel = page.locator("#wh-outbox-panel");
  await expect(panel).toContainText("전송 중단");
  await expect(panel).toContainText("HTTP 500");
  await expect(panel.locator("b")).toHaveCount(0); // 이름은 이스케이프된다
  await panel.getByRole("button", { name: "다시 보내기" }).click();
  await expect.poll(() => page.evaluate(() => window.__whCalls.some(c => c.method === "POST" && c.path.endsWith("/whob-1/retry")))).toBe(true);
});
