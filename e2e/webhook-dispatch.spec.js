// "연동 설정"(웹훅) 화면은 웹훅 등록·이벤트 선택 UI는 갖춰져 있었지만, 실제
// 결재 상신/완료/반려·휴가신청·공지등록 시점에 이를 호출하는 코드가 전혀 없어
// 관리자가 누르는 "테스트 전송" 버튼 외에는 절대 동작하지 않던 기능이었다.
// _fireIntegrationWebhooks()를 4개 실제 액션 지점에 배선해 완성했다(2026-09-09).
//
// 2026-10 고도화: 그 구현은 브라우저가 integrationSettings.webhooks[].url로 직접
// fetch하는 구조였는데, 그 URL(Slack Incoming Webhook URL 등 비밀값)이 "연동 설정"
// (admin 전용) 화면과 무관하게 모든 role의 GET /data 응답에 그대로 실려 있어야만
// 동작했다 — 즉 로그인한 누구나 그 URL을 읽어갈 수 있는 비밀값 노출이었다. 디스패치를
// 서버(POST /api/integrations/webhooks/dispatch)로 옮겨, 클라이언트는 이벤트id+문구만
// 보내고 서버가 자신이 가진(이제 non-admin에게는 숨겨진) webhook 목록으로 직접
// fetch한다. 그래서 아래 테스트들은 브라우저 메모리의 integrationSettings.webhooks만
// 바꾸는 것으로는 부족하고, 실제 서버에 그 설정을 저장(_doSave(true))한 뒤에야
// 서버 쪽 디스패치가 그 웹훅을 찾아 로컬 HTTP 목(mock) 수신 서버로 실제 fetch(POST)를
// 보낸다 — 목 서버가 요청을 받았는지로 "발송됐다"를 확인한다.
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
  // 로그인 버튼을 누르기 "전"에 오버라이드해야 하는 이유는 smoke.spec.js의 "확정
  // 평가가 성과급과..." 테스트 상세 주석 참고 — _completeLogin()이 클릭 직후
  // 백그라운드로 시작하는 loadFromServer()/SSE data_updated가, 이 테스트가 곧바로
  // _doSave(true)로 서버에 저장하는 webhook 설정을 덮어쓸 수 있는 경합을 막는다.
  await page.evaluate(() => {
    loadFromServer = async () => {};
    connectSSE = async () => {};
  });
  await page.click(".login-card button.btn-primary");
  await expect(page.locator("#main")).toBeVisible({ timeout: 10000 });
}

// 웹훅 설정을 브라우저 메모리에 세팅한 뒤 실제 서버에 저장(_doSave(true), 지연 없는
// 즉시 저장)한다 — 디스패치는 이제 서버가 loadData()로 직접 읽은 상태를 기준으로
// 동작하므로, 클라이언트 메모리만 바꿔서는 서버 쪽 fetch가 전혀 트리거되지 않는다.
//
// integrationSettings는 REVISIONED_SINGLETON_FIELDS라 저장 전 "현재 서버 revision"을
// 정확히 알아야 하는데, loginAsAdmin()이 loadFromServer()를 no-op으로 막아둔 탓에
// _singletonRevisions가 로그인 직후 항상 빈 상태({})에 머문다 — 이 파일의 두 번째 이후
// 테스트부터 이 함수를 또 호출하면 서버는 이미 이전 테스트가 올려둔 revision(예: 1)을
// 갖고 있는데 클라이언트는 그걸 전혀 모른 채 저장을 시도해 SINGLETON_REVISION_CONFLICT
// (409)로 조용히 거부되고, 그 직전 테스트가 등록해 둔(이미 닫힌 mock 서버를 가리키는)
// webhook이 그대로 남아 디스패치가 실제로는 아무 데도 도달하지 못하는 버그를 실측으로
// 발견했다 — loadFromServer() 전체를 호출하는 대신(그 함수가 하는 다른 부수효과까지
// 끌어오고, 애초에 이 테스트가 그 전역 이름 자체를 no-op으로 바꿔둬서 그 이름으로
// 호출해도 아무 일도 안 일어난다) 현재 서버의 _singletonRevisions만 직접 가져와
// 동기화한 뒤 저장한다.
async function setWebhooksAndSave(page, webhooks) {
  await page.evaluate(async (whs) => {
    const fresh = await serverRequest("GET", "/data");
    if (fresh.ok && fresh.data?._singletonRevisions) _singletonRevisions = { ...fresh.data._singletonRevisions };
    integrationSettings = { ...integrationSettings, webhooks: whs };
    await _doSave(true);
  }, webhooks);
}

test.describe("웹훅 자동 발송 배선", () => {
  let mock;

  test.beforeEach(async () => {
    mock = await startMockReceiver();
  });

  test.afterEach(async () => {
    // keep-alive 소켓이 살아있으면 close()가 그 연결이 끊어질 때까지 무기한
    // 대기해 다음 테스트까지 지연시킬 수 있다 — 응답은 이미 보낸 뒤이므로
    // 연결을 강제로 끊고 닫아도 안전하다.
    mock.server.closeAllConnections();
    await new Promise((resolve) => mock.server.close(resolve));
  });

  test("결재 상신 시 approval_request(+일반결재는 leave_request 미발송) 웹훅이 발송된다", async ({ page }) => {
    await loginAsAdmin(page);
    const webhookUrl = `http://127.0.0.1:${mock.port}/hook`;

    await setWebhooksAndSave(page, [
      { id: 1, name: "일반결재-훅", type: "custom", url: webhookUrl, active: true, events: ["approval_request", "leave_request"] },
    ]);
    await page.evaluate(() => {
      window._afPendingSubmit = { tplId: "tpl-general", fd: {}, approvers: [], receivers: [], ccList: [] };
      _doSubmitApprovalForm();
    });

    // 서버가 실제로 fetch를 보내기까지 약간의 시간이 걸린다.
    await expect.poll(() => mock.received.length, { timeout: 5000 }).toBeGreaterThanOrEqual(1);
    const bodies = mock.received.map((r) => JSON.parse(r.body).text);
    expect(bodies.some((t) => t.includes("결재 상신") && t.includes("일반 결재"))).toBe(true);
    // tpl-general은 category:"general"이라 leave_request는 발송되지 않아야 한다.
    expect(bodies.some((t) => t.includes("휴가/근태 신청"))).toBe(false);
  });

  test("휴가 신청(attendance 카테고리) 상신 시 approval_request와 leave_request가 함께 발송된다", async ({ page }) => {
    await loginAsAdmin(page);
    const webhookUrl = `http://127.0.0.1:${mock.port}/hook`;

    await setWebhooksAndSave(page, [
      { id: 1, name: "휴가-훅", type: "custom", url: webhookUrl, active: true, events: ["approval_request", "leave_request"] },
    ]);
    await page.evaluate(() => {
      window._afPendingSubmit = {
        tplId: "tpl-vacation",
        fd: { leaveType: "연차", startDate: "2026-09-10", endDate: "2026-09-10" },
        approvers: [],
        receivers: [],
        ccList: [],
      };
      _doSubmitApprovalForm();
    });

    await expect.poll(() => mock.received.length, { timeout: 5000 }).toBeGreaterThanOrEqual(2);
    const bodies = mock.received.map((r) => JSON.parse(r.body).text);
    expect(bodies.some((t) => t.includes("결재 상신"))).toBe(true);
    expect(bodies.some((t) => t.includes("휴가/근태 신청") && t.includes("연차"))).toBe(true);
  });

  test("최종 승인/반려 시 approval_complete 웹훅이 발송된다", async ({ page }) => {
    await loginAsAdmin(page);
    const webhookUrl = `http://127.0.0.1:${mock.port}/hook`;

    await setWebhooksAndSave(page, [
      { id: 1, name: "승인-훅", type: "custom", url: webhookUrl, active: true, events: ["approval_complete"] },
    ]);
    const texts = await page.evaluate(() => {
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
    });
    expect(texts).toBe(true);

    await expect.poll(() => mock.received.length, { timeout: 5000 }).toBeGreaterThanOrEqual(2);
    const bodies = mock.received.map((r) => JSON.parse(r.body).text);
    expect(bodies.some((t) => t.includes("결재 완료") && t.includes("테스트 결재 A"))).toBe(true);
    expect(bodies.some((t) => t.includes("결재 반려") && t.includes("테스트 결재 B"))).toBe(true);
  });

  test("공지사항 신규 등록 시에만 notice_post 웹훅이 발송되고, 일반 게시글은 발송되지 않는다", async ({ page }) => {
    await loginAsAdmin(page);
    const webhookUrl = `http://127.0.0.1:${mock.port}/hook`;

    await setWebhooksAndSave(page, [
      { id: 1, name: "게시판-훅", type: "custom", url: webhookUrl, active: true, events: ["notice_post"] },
    ]);

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

    await setWebhooksAndSave(page, [
      { id: 1, name: "미구독-훅", type: "custom", url: webhookUrl, active: true, events: ["notice_post"] }, // approval_request 미구독
      { id: 2, name: "비활성-훅", type: "custom", url: webhookUrl, active: false, events: ["approval_request"] }, // 비활성
    ]);
    await page.evaluate(() => {
      window._afPendingSubmit = { tplId: "tpl-general", fd: {}, approvers: [], receivers: [], ccList: [] };
      _doSubmitApprovalForm();
    });

    await page.waitForTimeout(500);
    expect(mock.received.length).toBe(0);
  });
});
// non-admin의 GET /data에 webhook URL이 더 이상 포함되지 않는지, 그리고 non-admin이
// 트리거한 디스패치 요청도 서버 저장분을 기준으로 정상 동작하는지는 실제 두 번째
// 로그인(별도 role 계정 생성+인증)이 필요해 브라우저 e2e보다 HTTP 레벨 API 테스트가
// 훨씬 안정적으로 검증한다 — test/api-integration-webhooks.test.js 참고.
