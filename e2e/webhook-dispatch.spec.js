// "연동 설정"(웹훅) 화면은 웹훅 등록·이벤트 선택 UI는 갖춰져 있었지만, 실제
// 결재 상신/완료/반려·휴가신청·공지등록 시점에 이를 호출하는 코드가 전혀 없어
// 관리자가 누르는 "테스트 전송" 버튼 외에는 절대 동작하지 않던 기능이었다.
// _fireIntegrationWebhooks()를 4개 실제 액션 지점에 배선한 뒤, 로컬 HTTP 목(mock)
// 수신 서버로 실제 fetch(POST)가 나가는지 검증한다 — fetch(...,{mode:"no-cors"})는
// 응답 본문을 JS에서 읽을 수 없을 뿐 요청 자체는 브라우저가 그대로 전송하므로,
// 목 서버가 요청을 받았는지로 "발송됐다"를 확인할 수 있다.
const { test, expect } = require("@playwright/test");
const http = require("http");

function startMockReceiver() {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ path: req.url, body });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, received, port: server.address().port }));
  });
}

async function loginAsAdmin(page) {
  await page.goto("/");
  await page.fill("#l-id", "e2e_admin");
  await page.fill("#l-pw", "E2eTestPw123");
  await page.click(".login-card button.btn-primary");
  await expect(page.locator("#main")).toBeVisible({ timeout: 10000 });
}

test.describe("웹훅 자동 발송 배선", () => {
  let mock;

  test.beforeEach(async () => {
    mock = await startMockReceiver();
  });

  test.afterEach(async () => {
    // no-cors fetch가 만든 keep-alive 소켓이 살아있으면 close()가 그 연결이
    // 끊어질 때까지 무기한 대기해 다음 테스트까지 지연시킬 수 있다 — 응답은
    // 이미 보낸 뒤이므로 연결을 강제로 끊고 닫아도 안전하다.
    mock.server.closeAllConnections();
    await new Promise((resolve) => mock.server.close(resolve));
  });

  test("결재 상신 시 approval_request(+일반결재는 leave_request 미발송) 웹훅이 발송된다", async ({ page }) => {
    await loginAsAdmin(page);
    const webhookUrl = `http://127.0.0.1:${mock.port}/hook`;

    await page.evaluate((url) => {
      integrationSettings.webhooks = [
        { id: 1, name: "일반결재-훅", type: "custom", url, active: true, events: ["approval_request", "leave_request"] },
      ];
      window._afPendingSubmit = { tplId: "tpl-general", fd: {}, approvers: [], receivers: [], ccList: [] };
      _doSubmitApprovalForm();
    }, webhookUrl);

    // no-cors fetch는 fire-and-forget이라 목 서버가 요청을 받을 때까지 잠시 대기.
    await expect.poll(() => mock.received.length, { timeout: 5000 }).toBeGreaterThanOrEqual(1);
    const bodies = mock.received.map((r) => JSON.parse(r.body).text);
    expect(bodies.some((t) => t.includes("결재 상신") && t.includes("일반 결재"))).toBe(true);
    // tpl-general은 category:"general"이라 leave_request는 발송되지 않아야 한다.
    expect(bodies.some((t) => t.includes("휴가/근태 신청"))).toBe(false);
  });

  test("휴가 신청(attendance 카테고리) 상신 시 approval_request와 leave_request가 함께 발송된다", async ({ page }) => {
    await loginAsAdmin(page);
    const webhookUrl = `http://127.0.0.1:${mock.port}/hook`;

    await page.evaluate((url) => {
      integrationSettings.webhooks = [
        { id: 1, name: "휴가-훅", type: "custom", url, active: true, events: ["approval_request", "leave_request"] },
      ];
      window._afPendingSubmit = {
        tplId: "tpl-vacation",
        fd: { leaveType: "연차", startDate: "2026-09-10", endDate: "2026-09-10" },
        approvers: [],
        receivers: [],
        ccList: [],
      };
      _doSubmitApprovalForm();
    }, webhookUrl);

    await expect.poll(() => mock.received.length, { timeout: 5000 }).toBeGreaterThanOrEqual(2);
    const bodies = mock.received.map((r) => JSON.parse(r.body).text);
    expect(bodies.some((t) => t.includes("결재 상신"))).toBe(true);
    expect(bodies.some((t) => t.includes("휴가/근태 신청") && t.includes("연차"))).toBe(true);
  });

  test("최종 승인/반려 시 approval_complete 웹훅이 발송된다", async ({ page }) => {
    await loginAsAdmin(page);
    const webhookUrl = `http://127.0.0.1:${mock.port}/hook`;

    const texts = await page.evaluate((url) => {
      integrationSettings.webhooks = [
        { id: 1, name: "승인-훅", type: "custom", url, active: true, events: ["approval_complete"] },
      ];
      const meId = currentUser.id;
      approvalDocs.push({
        id: "doc-approve-1",
        templateId: "tpl-general",
        title: "테스트 결재 A",
        authorId: meId,
        status: "in_progress",
        approvers: [{ empId: meId, status: "pending" }],
        receivers: [],
        cc: [],
        formData: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      approveApprovalDoc("doc-approve-1");

      approvalDocs.push({
        id: "doc-reject-1",
        templateId: "tpl-general",
        title: "테스트 결재 B",
        authorId: meId,
        status: "in_progress",
        approvers: [{ empId: meId, status: "pending" }],
        receivers: [],
        cc: [],
        formData: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      rejectApprovalDoc("doc-reject-1", "보류 사유");
      return true;
    }, webhookUrl);
    expect(texts).toBe(true);

    await expect.poll(() => mock.received.length, { timeout: 5000 }).toBeGreaterThanOrEqual(2);
    const bodies = mock.received.map((r) => JSON.parse(r.body).text);
    expect(bodies.some((t) => t.includes("결재 완료") && t.includes("테스트 결재 A"))).toBe(true);
    expect(bodies.some((t) => t.includes("결재 반려") && t.includes("테스트 결재 B"))).toBe(true);
  });

  test("공지사항 신규 등록 시에만 notice_post 웹훅이 발송되고, 일반 게시글은 발송되지 않는다", async ({ page }) => {
    await loginAsAdmin(page);
    const webhookUrl = `http://127.0.0.1:${mock.port}/hook`;

    await page.evaluate((url) => {
      integrationSettings.webhooks = [
        { id: 1, name: "게시판-훅", type: "custom", url, active: true, events: ["notice_post"] },
      ];
    }, webhookUrl);

    // 일반 게시글(공지 아님) → 발송되지 않아야 함
    await page.evaluate(() => {
      document.body.insertAdjacentHTML(
        "beforeend",
        `<div id="bp-form-scratch"><input id="bp-title" value="일반 잡담글"><textarea id="bp-content">내용</textarea><select id="bp-cat"><option value="general" selected>general</option></select></div>`
      );
      saveBoardPost();
      document.getElementById("bp-form-scratch")?.remove();
    });
    await page.waitForTimeout(500);
    expect(mock.received.length).toBe(0);

    // 공지사항 → 발송되어야 함
    await page.evaluate(() => {
      document.body.insertAdjacentHTML(
        "beforeend",
        `<div id="bp-form-scratch"><input id="bp-title" value="긴급 공지"><textarea id="bp-content">내용</textarea><select id="bp-cat"><option value="notice" selected>notice</option></select></div>`
      );
      saveBoardPost();
      document.getElementById("bp-form-scratch")?.remove();
    });

    await expect.poll(() => mock.received.length, { timeout: 8000 }).toBeGreaterThanOrEqual(1);
    const bodies = mock.received.map((r) => JSON.parse(r.body).text);
    expect(bodies.some((t) => t.includes("공지사항") && t.includes("긴급 공지"))).toBe(true);
  });

  test("이벤트를 구독하지 않은 웹훅이나 비활성 웹훅에는 발송되지 않는다", async ({ page }) => {
    await loginAsAdmin(page);
    const webhookUrl = `http://127.0.0.1:${mock.port}/hook`;

    await page.evaluate((url) => {
      integrationSettings.webhooks = [
        { id: 1, name: "미구독-훅", type: "custom", url, active: true, events: ["notice_post"] }, // approval_request 미구독
        { id: 2, name: "비활성-훅", type: "custom", url, active: false, events: ["approval_request"] }, // 비활성
      ];
      window._afPendingSubmit = { tplId: "tpl-general", fd: {}, approvers: [], receivers: [], ccList: [] };
      _doSubmitApprovalForm();
    }, webhookUrl);

    await page.waitForTimeout(500);
    expect(mock.received.length).toBe(0);
  });
});
