// 2026-10 고도화 — "연동 설정"(admin 전용)이 등록하는 Slack/카카오워크 웹훅 URL은
// 비밀값(Slack Incoming Webhook URL은 경로에 토큰이 박혀 있어, 아는 사람은 누구나 그
// 채널에 영구히 직접 게시 가능)인데, 결재 상신/완료·휴가신청·공지등록 시 "자동 발송"
// 기능(2026-09-09)이 브라우저에서 직접 그 URL로 fetch하는 구조라 integrationSettings
// 전체(webhooks[].url 포함)가 GET /data 응답에 role과 무관하게 전부 실려 있어야만
// 작동했다 — filterDataForRole()이 가리는 다른 모든 비밀값과 달리 이 필드만 한 번도
// 가려진 적이 없어, 로그인만 되어 있으면 어떤 role이든 URL을 그대로 읽어갈 수 있었다.
//
// 디스패치를 POST /api/integrations/webhooks/dispatch로 서버에 옮겨 해결했다 —
// 이 테스트는 (1) non-admin의 GET /data에서 webhooks가 완전히 제거되는지, (2) admin은
// 여전히 전체(URL 포함)를 보는지(기존 "연동 설정" 편집 화면이 깨지지 않도록), (3) 그
// 상태에서도 non-admin이 트리거한 디스패치 요청이 서버가 저장해둔 webhook으로 실제
// HTTP 전송까지 성공하는지(실제 로컬 mock 수신 서버로 검증), (4) 전송 결과가
// integrationLogs에 기록되고 그 기록이 다른 어떤 컬렉션도 건드리지 않는지, (5) 입력
// 검증·인증이 올바른지를 확인한다.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { startServer, bootstrapAdminAndLogin } = require("./support/start-server");

function startMockReceiver() {
  const received = [];
  let statusCode = 200;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", c => (body += c));
    req.on("end", () => {
      received.push(JSON.parse(body || "{}"));
      res.writeHead(statusCode, { "Content-Type": "application/json" });
      res.end("{}");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, received, setStatus: value => { statusCode = value; }, url: `http://127.0.0.1:${server.address().port}/hook` }));
  });
}

async function login(api, loginId, pw) {
  const r = await (await api("/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ loginId, pw }),
  })).json();
  assert.equal(r.ok, true, `${loginId} 로그인 실패: ${JSON.stringify(r)}`);
  return r.token;
}
function auth(token, method, body) {
  return {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  };
}
async function getData(api, token) {
  const r = await (await api("/data", { headers: { Authorization: `Bearer ${token}` } })).json();
  assert.equal(r.ok, true);
  return r;
}

test("웹훅 서버사이드 디스패치 — non-admin 비밀값 노출 차단 + 실제 전송 + 로그 기록", async (t) => {
  // 이 테스트의 mock 수신 서버는 127.0.0.1(loopback)이라, 아래 별도 테스트("SSRF 가드")가
  // 검증하는 보호를 그대로 두면 이 테스트의 디스패치 자체가 전부 막힌다 — 그 보호를
  // 명시적으로 켠(opt-in) 환경에서만 끈다(운영은 이 환경변수를 설정하지 않음).
  const server = await startServer({ env: { ALLOW_LOCAL_WEBHOOK_TARGETS: "true" } });
  t.after(() => server.stop());
  const api = (path, options) => fetch(server.baseUrl + path, options);

  const boot = await bootstrapAdminAndLogin(server, { loginId: "admin", pw: "admin-test-pw-1", name: "관리자" });
  const adminToken = boot.token;
  const initial = await getData(api, adminToken);

  const employees = [
    ...initial.data.employees,
    { id: "memberA", loginId: "memberA", pw: "memberA-pw-1", name: "팀원A", role: "member", active: true, dept: "개발본부", team: "A팀", menuPerms: {} },
  ];
  const now = new Date().toISOString();
  const seed = await api("/save", auth(adminToken, "POST", { _version: initial.version, employees,
    boardPosts: [{ id: "bp-untouched", title: "다른 컬렉션", authorId: "admin" }],
    approvalDocs: [{ id: "apv-member-1", authorId: "memberA", title: "member 트리거 테스트",
      templateId: "tpl-vacation", createdAt: now, updatedAt: now, status: "in_progress",
      approvers: [{ empId: "admin", status: "pending" }] }],
  }));
  assert.equal(seed.status, 200);
  const memberToken = await login(api, "memberA", "memberA-pw-1");

  const mock = await startMockReceiver();
  t.after(() => new Promise(resolve => { mock.server.closeAllConnections(); mock.server.close(resolve); }));

  await t.test("admin이 활성 웹훅을 등록한다", async () => {
    const d = await getData(api, adminToken);
    const save = await api("/save", auth(adminToken, "POST", {
      _version: d.version,
      integrationSettings: { webhooks: [
        { id: 1, name: "테스트훅", type: "custom", url: mock.url, active: true, events: ["approval_request"] },
        { id: 2, name: "미구독훅", type: "custom", url: mock.url, active: true, events: ["notice_post"] },
        { id: 3, name: "비활성훅", type: "custom", url: mock.url, active: false, events: ["approval_request"] },
      ], calendar: { includeLeave: true, includeRoomBooking: false } },
    }));
    assert.equal(save.status, 200);
  });

  await t.test("non-admin의 GET /data에는 webhooks 배열 자체가 없다(calendar는 그대로)", async () => {
    const d = await getData(api, memberToken);
    assert.equal(d.data.integrationSettings.webhooks, undefined);
    assert.deepEqual(d.data.integrationSettings.calendar, { includeLeave: true, includeRoomBooking: false });
  });

  await t.test("admin의 GET /data에는 URL을 포함한 전체 webhooks가 그대로 보인다(편집 화면 유지)", async () => {
    const d = await getData(api, adminToken);
    assert.equal(d.data.integrationSettings.webhooks.length, 3);
    assert.equal(d.data.integrationSettings.webhooks[0].url, mock.url);
  });

  await t.test("저장된 본인 결재 기록으로만 디스패치하고 임의 문구는 무시한다", async () => {
    const r = await (await api("/api/integrations/webhooks/dispatch", auth(memberToken, "POST", {
      eventId: "approval_request", recordId: "apv-member-1", text: "위조된 외부 알림",
    }))).json();
    assert.equal(r.ok, true);
    assert.equal(r.dispatched, 1); // 구독된 활성 웹훅은 1개(미구독훅·비활성훅 제외)
    assert.equal(mock.received.length, 1);
    assert.equal(mock.received[0].text, "[결재 상신] member 트리거 테스트 (신청자: 팀원A)");
    const duplicate = await (await api("/api/integrations/webhooks/dispatch", auth(memberToken, "POST", {
      eventId: "approval_request", recordId: "apv-member-1", text: "다른 문구",
    }))).json();
    assert.equal(duplicate.duplicate, true);
    assert.equal(mock.received.length, 1);
  });

  await t.test("전송 결과가 integrationLogs에 기록되고, 다른 컬렉션(boardPosts)은 전혀 건드리지 않는다", async () => {
    const d = await getData(api, adminToken);
    const log = d.data.integrationLogs.find(l => l.webhookName === "테스트훅");
    assert.ok(log, "integrationLogs에 기록이 없음");
    assert.equal(log.status, "success");
    assert.equal(log.event, "결재 요청 발생");
    const post = d.data.boardPosts.find(p => p.id === "bp-untouched");
    assert.ok(post, "무관한 boardPosts 레코드가 persistData() 부분쓰기로 사라짐");
    assert.equal(post.title, "다른 컬렉션");
  });

  await t.test("공지 알림은 저장된 작성자·제목을 사용하고 채널 멘션을 무력화한다", async () => {
    const d = await getData(api, adminToken);
    const post = { id: "notice-webhook-1", title: "@channel <긴급>", categoryId: "notice",
      authorId: String(d.data.employees[0].id), createdAt: new Date().toISOString() };
    const saved = await api("/save", auth(adminToken, "POST", { _version: d.version, boardPosts: [...d.data.boardPosts, post] }));
    assert.equal(saved.status, 200);
    const sent = await (await api("/api/integrations/webhooks/dispatch", auth(adminToken, "POST", {
      eventId: "notice_post", recordId: post.id, text: "위조 문구",
    }))).json();
    assert.equal(sent.dispatched, 1);
    assert.equal(mock.received.at(-1).text, "[공지사항] ＠channel &lt;긴급&gt;");
    const forged = await api("/api/integrations/webhooks/dispatch", auth(memberToken, "POST", {
      eventId: "notice_post", recordId: post.id,
    }));
    assert.equal(forged.status, 403);
  });

  await t.test("구독한 활성 웹훅이 없으면 아무것도 보내지 않고 dispatched:0을 반환한다", async () => {
    const before = mock.received.length;
    const r = await (await api("/api/integrations/webhooks/dispatch", auth(memberToken, "POST", {
      eventId: "leave_request", recordId: "apv-member-1",
    }))).json();
    assert.equal(r.ok, true);
    assert.equal(r.dispatched, 0);
    assert.equal(mock.received.length, before);
  });

  await t.test("알 수 없는 eventId는 400으로 거부된다", async () => {
    const r = await api("/api/integrations/webhooks/dispatch", auth(memberToken, "POST", { eventId: "not_a_real_event", recordId: "apv-member-1" }));
    assert.equal(r.status, 400);
  });

  await t.test("저장되지 않은 원본과 다른 사람의 결재 문서는 거부된다", async () => {
    const missing = await api("/api/integrations/webhooks/dispatch", auth(memberToken, "POST", { eventId: "approval_request", recordId: "not-saved" }));
    assert.equal(missing.status, 403);
    const other = await api("/api/integrations/webhooks/dispatch", auth(adminToken, "POST", { eventId: "approval_request", recordId: "apv-member-1" }));
    assert.equal(other.status, 403);
  });

  await t.test("토큰 없이는 401로 거부된다", async () => {
    const r = await api("/api/integrations/webhooks/dispatch", auth(null, "POST", { eventId: "approval_request", recordId: "apv-member-1" }));
    assert.equal(r.status, 401);
  });

  await t.test("member는 /save로 integrationSettings(webhooks)를 위조할 수 없다 — 저장본이 그대로 유지된다", async () => {
    const d = await getData(api, memberToken);
    const forged = await api("/save", auth(memberToken, "POST", {
      _version: d.version,
      integrationSettings: { webhooks: [{ id: 999, name: "위조", type: "custom", url: "http://evil.example/steal", active: true, events: ["approval_request"] }] },
    }));
    assert.equal(forged.status, 200); // 위조 필드만 되돌리고 요청 자체는 거부하지 않는 기존 관례
    const after = await getData(api, adminToken);
    assert.equal(after.data.integrationSettings.webhooks.length, 3); // 위조된 1건으로 교체되지 않음
    assert.ok(!after.data.integrationSettings.webhooks.some(w => w.url === "http://evil.example/steal"));
  });

  await t.test("연동 테스트는 관리자만 저장된 대상으로 발송하고 실제 HTTP 실패를 표시한다", async () => {
    const denied = await api("/api/integrations/webhooks/test", auth(memberToken, "POST", { webhookId: 1 }));
    assert.equal(denied.status, 403);
    const before = mock.received.length;
    const success = await (await api("/api/integrations/webhooks/test", auth(adminToken, "POST", { webhookId: 1, url: "http://evil.example" }))).json();
    assert.equal(success.delivered, true); assert.equal(mock.received.length, before + 1);
    mock.setStatus(503);
    const failure = await (await api("/api/integrations/webhooks/test", auth(adminToken, "POST", { webhookId: 1 }))).json();
    assert.equal(failure.ok, false); assert.equal(failure.delivered, false); assert.equal(failure.message, "HTTP 503");
    assert.equal(failure.log.status, "fail"); mock.setStatus(200);
  });

  await t.test("기안 메뉴 차단 후에는 저장된 본인 문서도 알림 재전송할 수 없다", async () => {
    const d = await getData(api, adminToken);
    await api("/save", auth(adminToken, "POST", { _version: d.version,
      employees: d.data.employees.map(e => e.id === "memberA" ? { ...e, menuPerms: { "approval-draft": false } } : e) }));
    const restrictedToken = await login(api, "memberA", "memberA-pw-1");
    const denied = await api("/api/integrations/webhooks/dispatch", auth(restrictedToken, "POST", { eventId: "approval_request", recordId: "apv-member-1" }));
    assert.equal(denied.status, 403);
  });
});

// 위 테스트는 ALLOW_LOCAL_WEBHOOK_TARGETS=true로 SSRF 가드를 꺼야만 동작했다 — 이 테스트는
// 그 플래그를 "켜지 않은" 기본(운영과 동일) 환경에서, 가드가 실제로 loopback/사설대역
// 목적지를 막는지를 직접 검증한다. 127.0.0.1(이 테스트 자신이 띄운 실제 mock 수신 서버)로의
// webhook을 등록하고 디스패치했을 때 요청이 전혀 도달하지 않아야 한다 — 서버 내부 함수를
// export해 단위테스트하는 대신, 이미 있는 "실제 로컬 mock 서버로 전송됐는지" 패턴을 그대로
// 재사용해 end-to-end로 확인한다(가드가 깨지면 이 테스트가 그 즉시 실패한다).
test("웹훅 서버사이드 디스패치 — SSRF 가드(기본값: 운영과 동일, 플래그 미설정)가 loopback 목적지를 막는다", async (t) => {
  const server = await startServer(); // ALLOW_LOCAL_WEBHOOK_TARGETS 미설정 — 가드가 기본 활성 상태
  t.after(() => server.stop());
  const api = (path, options) => fetch(server.baseUrl + path, options);

  const boot = await bootstrapAdminAndLogin(server, { loginId: "admin", pw: "admin-test-pw-1", name: "관리자" });
  const adminToken = boot.token;
  const initial = await getData(api, adminToken);

  const mock = await startMockReceiver();
  t.after(() => new Promise(resolve => { mock.server.closeAllConnections(); mock.server.close(resolve); }));

  const save = await api("/save", auth(adminToken, "POST", {
    _version: initial.version,
    approvalDocs: [{ id: "apv-ssrf", authorId: boot?.empId || initial.data.employees[0].id,
      title: "SSRF 가드 검증", templateId: "tpl-vacation", createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(), status: "in_progress", approvers: [{ empId: "memberA", status: "pending" }] }],
    integrationSettings: { webhooks: [
      { id: 1, name: "loopback훅", type: "custom", url: mock.url, active: true, events: ["approval_request"] },
      { id: 2, name: "IPv4매핑훅", type: "custom",
        url: `http://[::ffff:127.0.0.1]:${mock.server.address().port}/hook`, active: true, events: ["approval_request"] },
    ], calendar: {} },
  }));
  assert.equal(save.status, 200);

  const r = await (await api("/api/integrations/webhooks/dispatch", auth(adminToken, "POST", {
    eventId: "approval_request", recordId: "apv-ssrf",
  }))).json();
  assert.equal(r.ok, true);
  assert.equal(r.dispatched, 0, "loopback 목적지로는 실제 전송되면 안 됨");
  assert.equal(mock.received.length, 0, "mock 수신 서버에 요청이 도달하면 안 됨(SSRF 가드 실패)");

  const d = await getData(api, adminToken);
  const log = d.data.integrationLogs.find(l => l.webhookName === "loopback훅");
  assert.ok(log, "차단된 시도도 integrationLogs에 fail로 기록돼야 함");
  assert.equal(log.status, "fail");
  assert.match(log.message, /안전하지 않은/);
  const mapped = d.data.integrationLogs.find(l => l.webhookName === "IPv4매핑훅");
  assert.equal(mapped?.status, "fail", "IPv4 매핑 IPv6 주소도 차단해야 한다");
  const tested = await (await api("/api/integrations/webhooks/test", auth(adminToken, "POST", { webhookId: 1 }))).json();
  assert.equal(tested.delivered, false);
  assert.equal(mock.received.length, 0, "테스트 발송도 동일한 SSRF 보호 적용");
});

test("웹훅 디스패치는 3xx 리다이렉트를 따라가지 않는다", async (t) => {
  const server = await startServer({ env: { ALLOW_LOCAL_WEBHOOK_TARGETS: "true" } });
  t.after(() => server.stop());
  const api = (path, options) => fetch(server.baseUrl + path, options);
  const { token } = await bootstrapAdminAndLogin(server, { loginId: "admin", pw: "admin-test-pw-1", name: "관리자" });

  let redirectedRequests = 0;
  const destination = http.createServer((_req, res) => {
    redirectedRequests += 1;
    res.writeHead(200).end("ok");
  });
  await new Promise(resolve => destination.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { destination.closeAllConnections(); destination.close(resolve); }));
  const redirector = http.createServer((_req, res) => {
    res.writeHead(302, { Location: `http://127.0.0.1:${destination.address().port}/internal` }).end();
  });
  await new Promise(resolve => redirector.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { redirector.closeAllConnections(); redirector.close(resolve); }));

  const initial = await getData(api, token);
  const saved = await api("/save", auth(token, "POST", {
    _version: initial.version,
    approvalDocs: [{ id: "apv-redirect", authorId: initial.data.employees[0].id,
      title: "redirect test", templateId: "tpl-vacation", createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(), status: "in_progress", approvers: [{ empId: "admin", status: "pending" }] }],
    integrationSettings: { webhooks: [{ id: 1, name: "redirect", type: "custom",
      url: `http://127.0.0.1:${redirector.address().port}/hook`, active: true,
      events: ["approval_request"] }], calendar: {} },
  }));
  assert.equal(saved.status, 200);
  const dispatched = await (await api("/api/integrations/webhooks/dispatch", auth(token, "POST", {
    eventId: "approval_request", recordId: "apv-redirect",
  }))).json();
  assert.equal(dispatched.ok, true);
  assert.equal(dispatched.dispatched, 0);
  assert.equal(redirectedRequests, 0, "리다이렉트된 내부 주소에 요청이 도달하면 안 된다");
});
