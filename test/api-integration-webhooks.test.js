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
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", c => (body += c));
    req.on("end", () => {
      received.push(JSON.parse(body || "{}"));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, received, url: `http://127.0.0.1:${server.address().port}/hook` }));
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
  const seed = await api("/save", auth(adminToken, "POST", { _version: initial.version, employees, boardPosts: [{ id: "bp-untouched", title: "다른 컬렉션", authorId: "admin" }] }));
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

  await t.test("member가 이벤트id+문구만으로 디스패치를 트리거해도(URL을 몰라도) 실제 전송된다", async () => {
    const r = await (await api("/api/integrations/webhooks/dispatch", auth(memberToken, "POST", {
      eventId: "approval_request", text: "[결재 상신] member 트리거 테스트",
    }))).json();
    assert.equal(r.ok, true);
    assert.equal(r.dispatched, 1); // 구독된 활성 웹훅은 1개(미구독훅·비활성훅 제외)
    assert.equal(mock.received.length, 1);
    assert.equal(mock.received[0].text, "[결재 상신] member 트리거 테스트");
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

  await t.test("구독한 활성 웹훅이 없으면 아무것도 보내지 않고 dispatched:0을 반환한다", async () => {
    const before = mock.received.length;
    const r = await (await api("/api/integrations/webhooks/dispatch", auth(memberToken, "POST", {
      eventId: "leave_request", text: "[휴가/근태 신청] 아무도 구독 안 함",
    }))).json();
    assert.equal(r.ok, true);
    assert.equal(r.dispatched, 0);
    assert.equal(mock.received.length, before);
  });

  await t.test("알 수 없는 eventId는 400으로 거부된다", async () => {
    const r = await api("/api/integrations/webhooks/dispatch", auth(memberToken, "POST", { eventId: "not_a_real_event", text: "x" }));
    assert.equal(r.status, 400);
  });

  await t.test("빈 text는 400으로 거부된다", async () => {
    const r = await api("/api/integrations/webhooks/dispatch", auth(memberToken, "POST", { eventId: "approval_request", text: "   " }));
    assert.equal(r.status, 400);
  });

  await t.test("토큰 없이는 401로 거부된다", async () => {
    const r = await api("/api/integrations/webhooks/dispatch", auth(null, "POST", { eventId: "approval_request", text: "x" }));
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
    integrationSettings: { webhooks: [{ id: 1, name: "loopback훅", type: "custom", url: mock.url, active: true, events: ["approval_request"] }], calendar: {} },
  }));
  assert.equal(save.status, 200);

  const r = await (await api("/api/integrations/webhooks/dispatch", auth(adminToken, "POST", {
    eventId: "approval_request", text: "SSRF 가드 검증",
  }))).json();
  assert.equal(r.ok, true);
  assert.equal(r.dispatched, 0, "loopback 목적지로는 실제 전송되면 안 됨");
  assert.equal(mock.received.length, 0, "mock 수신 서버에 요청이 도달하면 안 됨(SSRF 가드 실패)");

  const d = await getData(api, adminToken);
  const log = d.data.integrationLogs.find(l => l.webhookName === "loopback훅");
  assert.ok(log, "차단된 시도도 integrationLogs에 fail로 기록돼야 함");
  assert.equal(log.status, "fail");
  assert.match(log.message, /안전하지 않은/);
});
