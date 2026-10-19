// 컬렉션 처리 순서 의존 가드(lib/field-order-guard.js) — 부팅 시 단언이 실제로 위반을 잡는지,
// 그리고 현재 서버가 쓰는 두 목록(게이팅 키 순서·GENERIC_LIST_FIELDS)이 규칙을 만족하는지 확인한다.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { findFieldOrderViolations, assertFieldOrder, FIELD_ORDER_DEPENDENCIES } = require("../lib/field-order-guard");
const { GENERIC_LIST_FIELDS } = require("../lib/collections");

test("올바른 순서(근거 컬렉션이 먼저)는 통과한다", () => {
  assert.deepEqual(findFieldOrderViolations(["trainingCourses", "x", "trainingEnrollments"]), []);
  assert.doesNotThrow(() => assertFieldOrder(["learningCourses", "learningAssignments", "trainingCourses", "trainingEnrollments"], "t"));
});

test("근거 컬렉션이 뒤에 오면 위반으로 잡고 부팅을 막는다", () => {
  const v = findFieldOrderViolations(["trainingEnrollments", "trainingCourses"]);
  assert.deepEqual(v, [{ field: "trainingEnrollments", need: "trainingCourses", problem: "after" }]);
  assert.throws(() => assertFieldOrder(["learningAssignments", "learningCourses"], "게이팅"), /field-order-guard.*learningCourses는 learningAssignments보다 먼저/);
});

test("의존 대상이 목록에서 빠진 경우도 위반이다(의존하는 필드만 있을 때)", () => {
  const v = findFieldOrderViolations(["trainingEnrollments"]);
  assert.deepEqual(v, [{ field: "trainingEnrollments", need: "trainingCourses", problem: "missing" }]);
  // 의존하는 필드 자체가 없으면 검사 대상이 아니다.
  assert.deepEqual(findFieldOrderViolations(["boardPosts"]), []);
});

test("현재 GENERIC_LIST_FIELDS는 모든 의존 규칙을 만족한다", () => {
  assert.deepEqual(findFieldOrderViolations(GENERIC_LIST_FIELDS), []);
  for (const [field, needs] of Object.entries(FIELD_ORDER_DEPENDENCIES)) assert.ok(needs.length && field);
});
