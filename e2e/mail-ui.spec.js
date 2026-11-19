const { test, expect } = require("@playwright/test");

async function loginAsAdmin(page) {
  await page.goto("/");
  await page.fill("#l-id", "e2e_admin");
  await page.fill("#l-pw", "E2eTestPw123");
  await page.evaluate(() => { autoSaveDebounced = () => {}; loadFromServer = async () => {}; connectSSE = async () => {}; });
  await page.click(".login-card button.btn-primary");
  await expect(page.locator("#main")).toBeVisible({ timeout: 10000 });
}

test("연동 설정의 이메일 카드가 설정 상태를 보여주고 테스트 메일을 요청한다", async ({ page }) => {
  await loginAsAdmin(page);
  await page.evaluate(async () => {
    const calls = (window.__mailCalls = []);
    serverConfig.enabled = true; serverConfig.url = location.origin;
    serverRequest = async (method, path, body) => {
      calls.push({ method, path, body });
      if (path === "/api/mail/status") return { ok: true, mail: { configured: true, host: "smtp.<b>x</b>.test", port: 587, secure: false, from: "hr@x.test", auth: true } };
      return { ok: true };
    };
    gotoPage("integrations");
    await new Promise(r => setTimeout(r, 400));
  });
  const panel = page.locator("#mail-status-panel");
  await expect(panel).toContainText("설정됨");
  await expect(panel).toContainText("hr@x.test");
  await expect(panel.locator("b")).toHaveCount(0); // 서버 주소는 이스케이프된다
  await page.fill("#mail-test-to", "bad");
  await page.getByRole("button", { name: "테스트 메일 보내기" }).click();
  await expect(page.locator(".toast").last()).toContainText("이메일을 올바르게");
  await page.fill("#mail-test-to", "me@company.test");
  await page.getByRole("button", { name: "테스트 메일 보내기" }).click();
  await expect.poll(() => page.evaluate(() => window.__mailCalls.some(c => c.method === "POST" && c.path === "/api/mail/test" && c.body.to === "me@company.test"))).toBe(true);
});

test("채용 결과 통보 모달: 이메일이 없는 지원자는 메일 발송을 선택할 수 없고, 있으면 요청에 sendEmail이 실린다", async ({ page }) => {
  await loginAsAdmin(page);
  await page.evaluate(() => {
    serverConfig.enabled = true; serverConfig.url = location.origin;
    recruitJobs = [{ id: "rj1", title: "영업 담당자" }];
    recruitCandidates = [
      { id: "rc1", jobId: "rj1", name: "메일없음", email: "", noticeHistory: [] },
      { id: "rc2", jobId: "rj1", name: "메일있음", email: "has@applicant.test", noticeHistory: [] },
    ];
    window.__noticeCalls = [];
    serverRequest = async (method, path, body) => {
      window.__noticeCalls.push({ method, path, body });
      const id = path.split("/")[4];
      return { ok: true, candidate: { ...recruitCandidates.find(c => c.id === id), noticeHistory: [{ result: body.result, issuedBy: "x", issuedAt: new Date().toISOString(), emailedTo: body.sendEmail ? "has@applicant.test" : undefined }] } };
    };
    window.open = () => null; // 인쇄 창은 열지 않는다
  });
  await page.evaluate(() => openRecruitNoticeModal("rc1"));
  await expect(page.locator("#rc-notice-email")).toBeDisabled();
  await page.evaluate(() => closeModal());
  await page.evaluate(() => openRecruitNoticeModal("rc2"));
  await expect(page.locator("#rc-notice-email")).toBeEnabled();
  await page.locator("#rc-notice-email").check();
  await page.locator("#rc-notice-message").fill("");
  await page.getByRole("button", { name: "발급" }).click();
  await expect(page.locator(".toast").last()).toContainText("통보 내용");
  await page.locator("#rc-notice-message").fill("합격을 축하합니다.");
  await page.getByRole("button", { name: "발급" }).click();
  await expect.poll(() => page.evaluate(() => window.__noticeCalls.some(c => c.path === "/api/recruit/candidates/rc2/notice" && c.body.sendEmail === true))).toBe(true);
  await expect(page.locator(".toast").last()).toContainText("has@applicant.test");
});

test("급여 종합 관리: 확정된 명세서가 없으면 안내만, 있으면 확인 후 서버에 안내 메일을 요청한다", async ({ page }) => {
  await loginAsAdmin(page);
  await page.evaluate(() => {
    window.__payCalls = [];
    _doSave = async () => {};
    serverConfig.enabled = true; serverConfig.url = location.origin;
    serverRequest = async (method, path, body) => {
      window.__payCalls.push({ method, path, body });
      return { ok: true, sent: 2, noEmail: 1, inactive: 0, failed: 0, total: 3 };
    };
    payslips = [];
    gotoPage("payroll-mgmt");
  });
  await page.getByRole("button", { name: /확정 안내 메일/ }).click();
  await expect(page.locator(".toast").last()).toContainText("확정된 명세서가 없습니다");
  expect(await page.evaluate(() => window.__payCalls.filter(c => c.path === "/api/payroll/notify-email").length)).toBe(0);

  await page.evaluate(() => {
    const y = _payMgmtState.year, m = _payMgmtState.month;
    payslips = [{ id: "p1", empId: "x1", year: y, month: m, confirmed: true }, { id: "p2", empId: "x2", year: y, month: m, confirmed: false }];
  });
  await page.getByRole("button", { name: /확정 안내 메일/ }).click();
  await page.getByRole("button", { name: "확인" }).click();
  await expect.poll(() => page.evaluate(() => window.__payCalls.filter(c => c.path === "/api/payroll/notify-email").length)).toBe(1);
  const call = await page.evaluate(() => ({ ...window.__payCalls.find(c => c.path === "/api/payroll/notify-email"), ym: [_payMgmtState.year, _payMgmtState.month] }));
  expect(call.path).toBe("/api/payroll/notify-email");
  expect(call.body).toEqual({ year: call.ym[0], month: call.ym[1] });
  await expect(page.locator(".toast").last()).toContainText("2/3명 발송");
  await expect(page.locator(".toast").last()).toContainText("이메일 없음 1명");
});
