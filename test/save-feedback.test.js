"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { saveRejectInfo, snapshotIntendedRecord, discrepancyKeys, findSilentRejections, REASONS } = require("../lib/save-feedback");

test("알 수 없는 사유 코드는 일반 권한 사유로 대체된다", () => {
  assert.equal(saveRejectInfo("NOPE").reason, "PERMISSION");
  assert.equal(saveRejectInfo("DEADLINE").level, "error");
  assert.equal(saveRejectInfo("TRAINING_WAITLISTED").level, "info");
  for (const [code, v] of Object.entries(REASONS)) assert.ok(v.message && v.level, `${code} 메시지/레벨 필수`);
});

test("스냅샷은 깊은 복사이며 서버 메타 필드는 제외한다", () => {
  const rec = { id: 1, name: "a", nested: { x: 1 }, _rev: 3, updatedAt: "t", pw: "h" };
  const snap = snapshotIntendedRecord(rec);
  rec.nested.x = 99;
  assert.equal(snap.nested.x, 1);
  assert.equal("_rev" in snap, false);
  assert.equal("pw" in snap, false);
});

test("키 순서가 달라도 같은 값이면 차이로 보지 않고, 숨겨진 키는 비교하지 않는다", () => {
  const snap = snapshotIntendedRecord({ id: 1, a: { x: 1, y: 2 }, hidden: "v", b: 5 });
  assert.deepEqual(discrepancyKeys(snap, { id: 1, a: { y: 2, x: 1 }, b: 6 }), ["b"]);
});

test("침묵 되돌림만 추가 항목이 되고, 이미 보고된 항목·삭제/숨김 항목은 건너뛴다", () => {
  const intended = [
    { field: "f", id: "1", isNew: false, snapshot: { id: "1", score: 5 } },
    { field: "f", id: "2", isNew: false, snapshot: { id: "2", score: 5 } },
    { field: "f", id: "3", isNew: true, snapshot: { id: "3", score: 5 } },
    { field: "f", id: "4", isNew: false, snapshot: { id: "4", score: 5 } },
    { field: "f", id: "5", isNew: false, snapshot: { id: "5", score: 5 } },
  ];
  const finals = { "1": { id: "1", score: 5 }, "2": { id: "2", score: 1 }, "4": { id: "4", score: 2 } };
  const out = findSilentRejections(intended, (f, id) => finals[id], new Set(["f\u00004"]), {
    partialReason: () => "DEADLINE", notSavedReason: () => "MODULE_DISABLED",
  });
  assert.deepEqual(out.map(x => [x.id, x.reason, x.fields]), [["2", "DEADLINE", ["score"]], ["3", "MODULE_DISABLED", []]]);
});

test("숫자와 같은 값의 문자열 정규화는 사용자가 바꾼 값으로 보지 않는다", () => {
  const snap = snapshotIntendedRecord({ id: "1", ownerId: 1, flag: true, n: 2 });
  assert.deepEqual(discrepancyKeys(snap, { id: "1", ownerId: "1", flag: "true", n: 3 }), ["n"]);
});
