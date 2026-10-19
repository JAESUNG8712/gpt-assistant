"use strict";
// 컬렉션 처리 순서 의존 가드.
//
// /save의 쓰기 게이팅 루프는 `_APPROVAL_GATED_FIELDS`(= _WRITE_GATED_FIELDS 키 순서)대로
// 컬렉션을 하나씩 처리한다. 일부 컬렉션은 "같은 요청의 다른 컬렉션"을 판정 근거로 삼는다.
// 예) 교육 신청은 정원·마감 여부를 같은 요청의 trainingCourses로 계산하는데, 그 값은
// 과정 컬렉션이 먼저 권한 검증을 거쳐 위조분이 걷어진 뒤여야만 믿을 수 있다. 순서가
// 바뀌면(누군가 키를 재배치) 일반 직원이 위조한 과정(정원 999·마감 해제)으로 신청이
// 통과하는 우회가 조용히 생긴다 — 코드 주석에만 의존하지 않고 서버 기동 시 단언한다.
const FIELD_ORDER_DEPENDENCIES = {
  learningAssignments: ["learningCourses"],
  trainingEnrollments: ["trainingCourses"],
};

// keys: 처리 순서대로의 필드명 배열. 위반 목록이 있으면 Error를 던진다(부팅 실패).
function findFieldOrderViolations(keys, deps = FIELD_ORDER_DEPENDENCIES) {
  const index = new Map(keys.map((key, i) => [key, i]));
  const violations = [];
  for (const [field, needs] of Object.entries(deps)) {
    if (!index.has(field)) continue;
    for (const need of needs) {
      if (!index.has(need)) violations.push({ field, need, problem: "missing" });
      else if (index.get(need) > index.get(field)) violations.push({ field, need, problem: "after" });
    }
  }
  return violations;
}

function assertFieldOrder(keys, label, deps = FIELD_ORDER_DEPENDENCIES) {
  const violations = findFieldOrderViolations(keys, deps);
  if (!violations.length) return;
  const detail = violations.map(v => v.problem === "missing"
    ? `${v.field}가 의존하는 ${v.need}가 목록에 없음`
    : `${v.need}는 ${v.field}보다 먼저 처리돼야 함`).join("; ");
  throw new Error(`[field-order-guard] ${label} 처리 순서 위반: ${detail}`);
}

module.exports = { FIELD_ORDER_DEPENDENCIES, findFieldOrderViolations, assertFieldOrder };
