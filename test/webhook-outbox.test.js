"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { retryDelays, nextOutboxState, DEFAULT_RETRY_DELAYS_MS } = require("../lib/webhook-outbox");

test("재시도 간격 환경변수는 숫자 목록만 받고 잘못되면 기본값을 쓴다", () => {
  assert.deepEqual(retryDelays("100, 200"), [100, 200]);
  assert.deepEqual(retryDelays("abc"), DEFAULT_RETRY_DELAYS_MS);
  assert.deepEqual(retryDelays(""), DEFAULT_RETRY_DELAYS_MS);
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
