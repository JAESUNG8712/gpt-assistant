"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { trackedFields, takePreImage, diffRevisions, capSnapshot } = require("../lib/record-revisions");

test("추적 대상에서 로그성 컬렉션은 제외되고 직원·KPI는 항상 포함된다", () => {
  const f = trackedFields(["boardPosts", "integrationLogs", "attendanceRecords", "okrObjectives"]);
  assert.deepEqual(f, ["employees", "kpiEntries", "boardPosts", "okrObjectives"]);
});

test("수정은 바뀌기 전 모습, 삭제는 마지막 모습을 보관하고 신규·무변경은 만들지 않는다", () => {
  const stored = { boardPosts: [{ id: 1, title: "원본", _rev: 1, updatedAt: "t1" }, { id: 2, title: "그대로", _rev: 1, updatedAt: "t1" }, { id: 3, title: "삭제될", _rev: 1, updatedAt: "t1" }] };
  const body = { boardPosts: [{ id: 1, title: "수정", _rev: 1, updatedAt: "t2" }, { id: 2, title: "그대로", _rev: 1, updatedAt: "t1" }, { id: 4, title: "신규" }], recordTombstones: { boardPosts: [{ id: 3 }] } };
  const pre = takePreImage(stored, body, ["boardPosts"]);
  const after = { boardPosts: [{ id: 1, title: "수정", _rev: 2, updatedAt: "t2" }, { id: 2, title: "그대로", _rev: 1, updatedAt: "t1" }, { id: 4, title: "신규" }] };
  const out = diffRevisions(pre, after);
  assert.deepEqual(out.map(x => [x.recordId, x.operation, x.snapshot.title]).sort(), [["1", "update", "원본"], ["3", "delete", "삭제될"]]);
});

test("서버 메타(_rev·updatedAt)만 바뀐 저장은 이력을 만들지 않는다", () => {
  const stored = { okrObjectives: [{ id: "a", title: "x", _rev: 1, updatedAt: "t1" }] };
  const pre = takePreImage(stored, { okrObjectives: [{ id: "a", title: "x" }] }, ["okrObjectives"]);
  assert.deepEqual(diffRevisions(pre, { okrObjectives: [{ id: "a", title: "x", _rev: 2, updatedAt: "t9" }] }), []);
});

test("보관용 사본은 비밀번호와 아주 큰 값을 제외한다", () => {
  const snap = capSnapshot({ id: 1, pw: "hash", photoUrl: "x".repeat(200_000), name: "a" });
  assert.equal("pw" in snap, false);
  assert.equal("photoUrl" in snap, false);
  assert.deepEqual(snap._truncatedKeys, ["photoUrl"]);
});

test("중첩 객체·배열의 인증정보와 첨부도 제외하고 원본은 변경하지 않는다", () => {
  const source = { id: 1, twoFactorSecret: "old-otp", authVersion: 7,
    custom: { access_token: "token-value", salary: 100, rows: [{ passwordHash: "hash-value", label: "정상", attachment: "x".repeat(100001) }] } };
  const snap = capSnapshot(source);
  const text = JSON.stringify(snap);
  assert.ok(!text.includes("old-otp"));
  assert.ok(!text.includes("token-value"));
  assert.ok(!text.includes("hash-value"));
  assert.equal(snap.custom.salary, 100);
  assert.equal(snap.custom.rows[0].label, "정상");
  assert.ok(snap._truncatedKeys.includes("custom.rows.0.attachment"));
  assert.ok(snap._redactedKeys.includes("custom.access_token"));
  assert.equal(source.custom.access_token, "token-value");
  assert.deepEqual(capSnapshot(snap), snap, "legacy read/write sanitation must be idempotent");
});

test("개별 값이 작아도 총 크기·노드·깊이를 제한하고 불완전 표시를 남긴다", () => {
  const large = capSnapshot({ id: 1, rows: Array.from({ length: 100 }, () => ({ text: "가".repeat(2000) })) });
  assert.ok(Buffer.byteLength(JSON.stringify(large), "utf8") <= 262144);
  assert.ok(large._truncatedKeys.length);
  let deep = { value: "end" };
  for (let i = 0; i < 100; i++) deep = { child: deep };
  assert.ok(capSnapshot(deep)._truncatedKeys.length);
  assert.ok(capSnapshot({ rows: Array.from({ length: 12000 }, () => 1) })._truncatedKeys.length);
});
