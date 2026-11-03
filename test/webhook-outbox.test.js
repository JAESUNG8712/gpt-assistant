"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { retryDelays, nextOutboxState, DEFAULT_RETRY_DELAYS_MS } = require("../lib/webhook-outbox");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Exercise the real JSON storage functions without waiting 120 seconds or adding
// a production-only test route. Only their storage/clock dependencies are stubbed.
function leaseHarness(row) {
  const source = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
  const start = source.indexOf("async function _outboxClaimDue(");
  const end = source.indexOf("async function _outboxList(", start);
  assert.ok(start >= 0 && end > start);
  let writes = 0;
  const context = { USE_JSON_FILE: true, SENDING_LEASE_MS: 120000, WEBHOOK_RETRY_DELAYS: [1000],
    crypto: require("node:crypto"), Date, nextOutboxState,
    ownsOutboxClaim: require("../lib/webhook-outbox").ownsOutboxClaim,
    _fileOutbox: { entries: [row] }, _loadFileOutbox() {},
    _saveFileOutbox() { writes++; }, _withOutboxLock: fn => Promise.resolve().then(fn) };
  const api = vm.runInNewContext(source.slice(start, end) +
    ";({claim:_outboxClaimDue,finish:_outboxFinish,renew:typeof _outboxRenew==='function'?_outboxRenew:null})", context);
  return { ...api, writes: () => writes };
}

test("회수된 임대의 늦은 성공·실패 응답은 새 작업자의 결과를 덮어쓰지 않는다", async () => {
  const row = { id: "job", companyId: "A", status: "sending", attempts: 0,
    claimToken: "old-worker", nextAttemptAt: new Date(Date.now() - 1000).toISOString() };
  const old = { ...row };
  const store = leaseHarness(row);
  const [current] = await store.claim(1);
  assert.equal(await store.finish(old, "failed", "late failure"), null);
  assert.equal(row.status, "sending");
  assert.notEqual(current.claimToken, old.claimToken);
  assert.equal((await store.finish(current, "sent", "HTTP 200")).status, "sent");
  const saved = JSON.stringify(row), writes = store.writes();
  assert.equal(await store.finish(old, "sent", "late success"), null);
  assert.equal(await store.finish(current, "failed", "duplicate callback"), null);
  assert.equal(JSON.stringify(row), saved);
  assert.equal(store.writes(), writes);
});

test("발송 직전 임대 검사는 만료·토큰 누락·다른 회사·이전 작업자를 거부한다", async () => {
  const row = { id: "job", companyId: "A", status: "pending", attempts: 0,
    nextAttemptAt: new Date(Date.now() - 1000).toISOString() };
  const store = leaseHarness(row);
  const [entry] = await store.claim(1);
  assert.ok(await store.renew(entry));
  assert.equal(await store.renew({ ...entry, claimToken: undefined }), false);
  assert.equal(await store.renew({ ...entry, claimToken: "old-worker" }), false);
  assert.equal(await store.renew({ ...entry, companyId: "B" }), false);
  assert.equal(await store.finish({ ...entry, companyId: "B" }, "sent", ""), null);
  row.nextAttemptAt = new Date(Date.now() - 1000).toISOString();
  assert.equal(await store.renew(entry), false);
  assert.equal(await store.finish(entry, "sent", ""), null);
  const [reclaimed] = await store.claim(1);
  assert.notEqual(reclaimed.claimToken, entry.claimToken);
  assert.ok(await store.renew(reclaimed));
});

test("워커는 발송 직전에 한 건씩 점유하고 한 주기에 최대 20건만 처리한다", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
  const start = source.indexOf("async function _processWebhookOutbox(");
  const end = source.indexOf("const webhookTestLimiter", start);
  assert.ok(start >= 0 && end > start);
  let claims = 0, delivered = 0, logged = 0;
  const context = { _outboxWorkerRunning: false, _outboxLastPrune: Date.now(), Date, Map, console,
    _scopeKey: id => id || "default",
    async _outboxClaimDue(limit) {
      assert.equal(limit, 1, "대기할 작업을 미리 점유하지 않아야 함");
      assert.equal(claims, delivered, "앞선 전송이 완료된 뒤 다음 작업을 점유해야 함");
      return [{ id: ++claims, companyId: "A", webhookId: "hook", attempts: 0 }];
    },
    async _drainSaveEffects() {},
    async loadData() { return { integrationSettings: { webhooks: [{ id: "hook" }] } }; },
    async _deliverOutboxEntry() { delivered++; return { status: "superseded" }; },
    async _recordWebhookLogs() { logged++; },
    async _outboxFinish() { assert.fail("정상 흐름에서 실패로 처리하면 안 됨"); },
    _safeErrMsg: e => e.message };
  await vm.runInNewContext(source.slice(start, end) + ";_processWebhookOutbox()", context);
  assert.equal(claims, 20);
  assert.equal(delivered, 20);
  assert.equal(logged, 0, "소유권을 잃은 결과는 최신 발송 이력에 기록하지 않음");
  assert.equal(context._outboxWorkerRunning, false);
});

test("재시도 간격 환경변수는 숫자 목록만 받고 잘못되면 기본값을 쓴다", () => {
  assert.deepEqual(retryDelays("100, 200"), [100, 200]);
  assert.deepEqual(retryDelays("abc"), DEFAULT_RETRY_DELAYS_MS);
  assert.deepEqual(retryDelays(""), DEFAULT_RETRY_DELAYS_MS);
});

test("느린 첫 발송 중 연동이 해제되면 다음 작업은 최신 설정을 읽는다", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
  const start = source.indexOf("async function _processWebhookOutbox(");
  const end = source.indexOf("const webhookTestLimiter", start);
  let claimed = 0, delivered = 0, reads = 0;
  const activeTargets = [];
  const context = { Date, Map, console, _scopeKey: x => x, _outboxWorkerRunning: false, _outboxLastPrune: Date.now(),
    async _drainSaveEffects() {},
    async _outboxClaimDue() { return claimed++ < 2 ? [{ companyId: "A", webhookId: "hook", attempts: 0 }] : []; },
    async loadData() { reads++; return { integrationSettings: { webhooks: [{ id: "hook", active: delivered === 0 }] } }; },
    async _deliverOutboxEntry(entry, wh) { activeTargets.push(wh.active); delivered++; return { status: "cancelled" }; },
    async _outboxFinish() { assert.fail("최신 설정 확인 실패"); },
    _safeErrMsg: e => e.message };
  await vm.runInNewContext(source.slice(start, end) + ";_processWebhookOutbox()", context);
  assert.deepEqual(activeTargets, [true, false]);
  assert.equal(reads, 2);
});

test("성공/실패/취소 상태 전이", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  const delays = [1000, 2000];
  assert.equal(nextOutboxState({ attempts: 0 }, "sent", "", now, delays).status, "sent");
  const f1 = nextOutboxState({ attempts: 0 }, "failed", "HTTP 500", now, delays);
  assert.deepEqual([f1.status, f1.attempts, f1.nextAttemptAt], ["pending", 1, new Date(now + 1000).toISOString()]);
  const f2 = nextOutboxState({ attempts: 1 }, "failed", "x", now, delays);
  assert.deepEqual([f2.status, f2.attempts, f2.nextAttemptAt], ["pending", 2, new Date(now + 2000).toISOString()]);
  const dead = nextOutboxState({ attempts: 2 }, "failed", "x", now, delays);
  assert.deepEqual([dead.status, dead.attempts], ["dead", 3]);
  assert.equal(nextOutboxState({ attempts: 1 }, "cancelled", "삭제", now, delays).attempts, 1);
});
