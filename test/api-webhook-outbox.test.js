"use strict";
// 웹훅 알림이 수신 서버 장애로 실패해도 서버가 영속 대기함에서 재시도하는지 검증한다.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { startServer, bootstrapAdminAndLogin } = require("./support/start-server");

function startReceiver() {
  const received = [];
  let status = 500;
  const server = http.createServer((req, res) => {
    let body = ""; req.on("data", c => (body += c));
    req.on("end", () => { received.push({ status, body: JSON.parse(body || "{}") }); res.writeHead(status); res.end("{}"); });
  });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve({ server, received, setStatus: v => { status = v; }, url: `http://127.0.0.1:${server.address().port}/hook` })));
}
const auth = (token, method, body) => ({ method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 8000) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error("대기 시간 초과"); await sleep(100); } }

test("저장 직후 프로세스가 종료되어도 브라우저 dispatch 없이 알림과 이력을 재기동 후 복구한다", async t => {
  const fs = require("node:fs");
  const { once } = require("node:events");
  const server = await startServer({ env: { ALLOW_LOCAL_WEBHOOK_TARGETS: "true", WEBHOOK_OUTBOX_POLL_MS: "60000" } });
  t.after(() => server.stop());
  const boot = await bootstrapAdminAndLogin(server, { loginId: "admin", pw: "admin-test-pw-1" });
  const api = (p, o) => fetch(server.baseUrl + p, o);
  const get = async () => (await api("/data", auth(boot.token, "GET"))).json();
  const rx = await startReceiver(); rx.setStatus(200);
  t.after(() => new Promise(r => { rx.server.closeAllConnections(); rx.server.close(r); }));
  let d = await get();
  const post = { id: "atomic-notice", categoryId: "notice", authorId: String(d.data.employees[0].id), title: "저장된 공지", createdAt: new Date().toISOString() };
  const save = body => api("/save", auth(boot.token, "POST", body));
  assert.equal((await save({ _version: d.version, boardPosts: [post],
    integrationSettings: { webhooks: [{ id: "atomic", url: rx.url, name: "원자성", active: true, events: ["notice_post"] }] },
    _pendingSaveEffects: [{ events: [{ text: "forged" }] }],
  })).status, 200);
  d = await get();
  assert.ok(!Object.hasOwn(d.data, "_pendingSaveEffects"));
  assert.equal((await save({ _version: d.version, boardPosts: [{ ...d.data.boardPosts[0], title: "수정된 공지", updatedAt: new Date(Date.now() + 1000).toISOString() }] })).status, 200);
  const durable = JSON.parse(fs.readFileSync(server.dataFile, "utf8"));
  assert.equal(durable._pendingSaveEffects.flatMap(x => x.events).length, 1, "재저장/수정은 신규 공지 알림이 아님");
  assert.ok(durable._pendingSaveEffects.flatMap(x => x.revisions).length >= 1);
  assert.equal(rx.received.length, 0, "클라이언트 dispatch를 호출하지 않았다");
  // Outbox succeeds but the history sidecar fails: the unfinished journal must
  // survive, and a second read must not overwrite corrupt history with empty data.
  const revisionFile = server.dataFile.replace(/\.json$/, "-record-revisions.json");
  fs.writeFileSync(revisionFile, "broken-history");
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.equal((await api("/api/record-revisions", auth(boot.token, "GET"))).status, 500);
    assert.equal(fs.readFileSync(revisionFile, "utf8"), "broken-history");
  }
  assert.ok(JSON.parse(fs.readFileSync(server.dataFile, "utf8"))._pendingSaveEffects.length > 0);
  fs.writeFileSync(revisionFile, JSON.stringify({ entries: [] }));
  const exited = once(server.child, "exit"); server.child.kill("SIGKILL"); await exited;
  const restarted = await startServer({ env: { DATA_FILE: server.dataFile, ALLOW_LOCAL_WEBHOOK_TARGETS: "true", WEBHOOK_OUTBOX_POLL_MS: "200" } });
  t.after(() => restarted.stop());
  t.after(() => fs.rmSync(server.dataDir, { recursive: true, force: true }));
  await until(() => rx.received.length === 1);
  const history = await (await fetch(restarted.baseUrl + "/api/record-revisions?field=boardPosts", auth(boot.token, "GET"))).json();
  assert.ok(history.revisions.some(r => r.recordId === post.id && r.title === "저장된 공지"));
  await sleep(500);
  assert.equal(rx.received.length, 1, "재기동/반복 poll은 중복 발송하지 않음");
});

test("발송 대기 중 요청자의 메뉴 권한이 철회되면 수동 재시도도 발송하지 않는다", async t => {
  const server = await startServer({ env: { ALLOW_LOCAL_WEBHOOK_TARGETS: "true", WEBHOOK_OUTBOX_POLL_MS: "60000" } });
  t.after(() => server.stop());
  const boot = await bootstrapAdminAndLogin(server, { loginId: "admin", pw: "admin-test-pw-1" });
  const api = (p, o) => fetch(server.baseUrl + p, o);
  const rx = await startReceiver(); rx.setStatus(200);
  t.after(() => new Promise(r => { rx.server.closeAllConnections(); rx.server.close(r); }));
  let d = await (await api("/data", auth(boot.token, "GET"))).json();
  const author = d.data.employees[0];
  await api("/save", auth(boot.token, "POST", { _version: d.version,
    boardPosts: [{ id: "revoked-post", authorId: String(author.id), categoryId: "notice", title: "발송 취소", createdAt: new Date().toISOString() }],
    integrationSettings: { webhooks: [{ id: "revoked", name: "훅", url: rx.url, events: ["notice_post"] }] } }));
  d = await (await api("/data", auth(boot.token, "GET"))).json();
  await api("/save", auth(boot.token, "POST", { _version: d.version, employees: d.data.employees.map(e => ({ ...e,
    menuPerms: { ...(e.menuPerms || {}), "board-notice": false }, updatedAt: new Date(Date.now() + 2000).toISOString() })) }));
  const list = await (await api("/api/integrations/webhooks/outbox", auth(boot.token, "GET"))).json();
  const id = list.entries[0].id;
  assert.equal((await api(`/api/integrations/webhooks/outbox/${id}/retry`, auth(boot.token, "POST"))).status, 200);
  await until(async () => (await (await api("/api/integrations/webhooks/outbox", auth(boot.token, "GET"))).json()).entries.some(e => e.status === "cancelled"));
  assert.equal(rx.received.length, 0);
});

test("수신 서버 장애로 실패한 알림은 대기함에서 재시도되어 결국 전달된다", async t => {
  const server = await startServer({ env: { ALLOW_LOCAL_WEBHOOK_TARGETS: "true", WEBHOOK_RETRY_DELAYS_MS: "300,300", WEBHOOK_OUTBOX_POLL_MS: "200" } });
  t.after(() => server.stop());
  const api = (p, o) => fetch(server.baseUrl + p, o);
  const boot = await bootstrapAdminAndLogin(server, { loginId: "admin", pw: "admin-test-pw-1", name: "관리자" });
  const token = boot.token;
  const rx = await startReceiver();
  t.after(() => new Promise(r => { rx.server.closeAllConnections(); rx.server.close(r); }));
  let d = await (await api("/data", { headers: { Authorization: `Bearer ${token}` } })).json();
  const adminId = String(d.data.employees[0].id);
  const now = new Date().toISOString();
  const doc = { id: "apv-1", authorId: adminId, title: "재시도 테스트", templateId: "tpl-general", createdAt: now, updatedAt: now, status: "in_progress", approvers: [{ empId: "x", status: "pending" }] };
  let r = await api("/save", auth(token, "POST", { _version: d.version, approvalDocs: [doc],
    integrationSettings: { webhooks: [{ id: 1, name: "훅", type: "custom", url: rx.url, active: true, events: ["approval_request"] }], calendar: {} } }));
  assert.equal(r.status, 200);

  // 1) 첫 시도는 500 → 실패하지만 재시도 예약
  const first = await (await api("/api/integrations/webhooks/dispatch", auth(token, "POST", { eventId: "approval_request", recordId: "apv-1" }))).json();
  assert.equal(first.ok, true);
  assert.equal(first.dispatched, 0);
  assert.ok(first.duplicate || (first.failed === 1 && first.retryScheduled === 1), JSON.stringify(first));
  await until(() => rx.received.some(x => x.status === 500));

  // 2) 같은 이벤트를 다시 요청해도 중복 접수되지 않는다
  const dup = await (await api("/api/integrations/webhooks/dispatch", auth(token, "POST", { eventId: "approval_request", recordId: "apv-1" }))).json();
  assert.equal(dup.duplicate, true);

  // 3) 수신 서버가 복구되면 워커가 알아서 다시 보내 'sent'가 된다
  rx.setStatus(200);
  const sent = await until(async () => {
    const o = await (await api("/api/integrations/webhooks/outbox", { headers: { Authorization: `Bearer ${token}` } })).json();
    return o.entries.find(e => e.status === "sent");
  });
  assert.ok(sent.attempts >= 2);
  assert.ok(rx.received.some(x => x.status === 200), "복구 후 실제로 전달되어야 한다");
  const body = await (await api("/api/integrations/webhooks/outbox", { headers: { Authorization: `Bearer ${token}` } })).json();
  assert.equal(body.summary.sent, 1);
  assert.equal(body.summary.pending, 0);
  assert.ok(body.entries.every(e => !Object.hasOwn(e, "claimToken") && !Object.hasOwn(e, "claim_token")), "내부 작업 소유 토큰은 API 응답에 노출하지 않는다");
});

test("끝내 실패해 중단된 알림은 관리자가 수동으로 다시 보낼 수 있고 권한이 없으면 목록을 볼 수 없다", async t => {
  const server = await startServer({ env: { ALLOW_LOCAL_WEBHOOK_TARGETS: "true", WEBHOOK_RETRY_DELAYS_MS: "100", WEBHOOK_OUTBOX_POLL_MS: "200" } });
  t.after(() => server.stop());
  const api = (p, o) => fetch(server.baseUrl + p, o);
  const boot = await bootstrapAdminAndLogin(server, { loginId: "admin", pw: "admin-test-pw-1", name: "관리자" });
  const token = boot.token;
  const rx = await startReceiver();
  t.after(() => new Promise(r => { rx.server.closeAllConnections(); rx.server.close(r); }));
  let d = await (await api("/data", { headers: { Authorization: `Bearer ${token}` } })).json();
  const adminId = String(d.data.employees[0].id);
  const now = new Date().toISOString();
  await api("/save", auth(token, "POST", { _version: d.version,
    employees: [...d.data.employees, { id: "m1", loginId: "m1", pw: "member-pw-1", name: "직원", role: "member", active: true, dept: "개발" }],
    approvalDocs: [{ id: "apv-2", authorId: adminId, title: "수동", templateId: "tpl-general", createdAt: now, updatedAt: now, status: "in_progress", approvers: [{ empId: "x", status: "pending" }] }],
    integrationSettings: { webhooks: [{ id: 1, name: "훅", type: "custom", url: rx.url, active: true, events: ["approval_request"] }], calendar: {} } }));
  await api("/api/integrations/webhooks/dispatch", auth(token, "POST", { eventId: "approval_request", recordId: "apv-2" }));
  const dead = await until(async () => {
    const o = await (await api("/api/integrations/webhooks/outbox", { headers: { Authorization: `Bearer ${token}` } })).json();
    return o.entries.find(e => e.status === "dead");
  });
  assert.match(dead.lastError, /HTTP 500/);

  const memberLogin = await (await api("/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ loginId: "m1", pw: "member-pw-1" }) })).json();
  const denied = await api("/api/integrations/webhooks/outbox", { headers: { Authorization: `Bearer ${memberLogin.token}` } });
  assert.equal(denied.status, 403);
  const deniedRetry = await api(`/api/integrations/webhooks/outbox/${dead.id}/retry`, auth(memberLogin.token, "POST"));
  assert.equal(deniedRetry.status, 403);

  rx.setStatus(200);
  const retry = await api(`/api/integrations/webhooks/outbox/${dead.id}/retry`, auth(token, "POST"));
  assert.equal(retry.status, 200);
  await until(async () => {
    const o = await (await api("/api/integrations/webhooks/outbox", { headers: { Authorization: `Bearer ${token}` } })).json();
    return o.entries.find(e => e.id === dead.id && e.status === "sent");
  });
  const none = await api("/api/integrations/webhooks/outbox/nope/retry", auth(token, "POST"));
  assert.equal(none.status, 404);
});

test("연동이 삭제되면 대기 중이던 알림은 보내지 않고 취소된다", async t => {
  const server = await startServer({ env: { ALLOW_LOCAL_WEBHOOK_TARGETS: "true", WEBHOOK_RETRY_DELAYS_MS: "1500", WEBHOOK_OUTBOX_POLL_MS: "200" } });
  t.after(() => server.stop());
  const api = (p, o) => fetch(server.baseUrl + p, o);
  const boot = await bootstrapAdminAndLogin(server, { loginId: "admin", pw: "admin-test-pw-1", name: "관리자" });
  const token = boot.token;
  const rx = await startReceiver();
  t.after(() => new Promise(r => { rx.server.closeAllConnections(); rx.server.close(r); }));
  let d = await (await api("/data", { headers: { Authorization: `Bearer ${token}` } })).json();
  const adminId = String(d.data.employees[0].id);
  const now = new Date().toISOString();
  await api("/save", auth(token, "POST", { _version: d.version,
    approvalDocs: [{ id: "apv-3", authorId: adminId, title: "취소", templateId: "tpl-general", createdAt: now, updatedAt: now, status: "in_progress", approvers: [{ empId: "x", status: "pending" }] }],
    integrationSettings: { webhooks: [{ id: 1, name: "훅", type: "custom", url: rx.url, active: true, events: ["approval_request"] }], calendar: {} } }));
  await api("/api/integrations/webhooks/dispatch", auth(token, "POST", { eventId: "approval_request", recordId: "apv-3" }));
  d = await (await api("/data", { headers: { Authorization: `Bearer ${token}` } })).json();
  await api("/save", auth(token, "POST", { _version: d.version, _singletonRevisions: d._singletonRevisions,
    integrationSettings: { webhooks: [], calendar: {} } }));
  const before = rx.received.length;
  const cancelled = await until(async () => {
    const o = await (await api("/api/integrations/webhooks/outbox", { headers: { Authorization: `Bearer ${token}` } })).json();
    return o.entries.find(e => e.status === "cancelled");
  }, 10000);
  assert.ok(cancelled);
  assert.equal(rx.received.length, before, "삭제된 연동으로는 더 이상 보내지 않는다");
});
