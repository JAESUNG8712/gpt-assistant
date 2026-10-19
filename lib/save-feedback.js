"use strict";
// 저장 거부 사유 피드백.
//
// /save(전체 상태 동기화)는 권한·확정 상태·값 검증·정원·마감 등으로 일부 레코드/필드를 저장하지
// 않고 서버 값으로 되돌린다. 예전에는 일부 경로만 "무엇이 거부됐는지"(id)를 알렸을 뿐 "왜"는
// 알리지 않았고, 필드 단위 되돌림(KPI 승인·직원 정보 등)은 아예 침묵했다. 이 모듈은
//  1) 사유 코드↔사용자용 메시지 카탈로그,
//  2) 사용자가 실제로 바꾼 값(snapshot)과 최종 저장 값을 비교해 침묵 되돌림을 찾아내는
//     순수 함수(서버 로직과 분리해 단위 테스트 가능)
// 를 제공한다.

const REASONS = {
  PERMISSION: { level: "error", message: "저장 권한이 없거나 허용되지 않는 변경이라 반영되지 않았습니다. 메뉴 권한·역할·승인/확정 상태를 확인하세요." },
  VALIDATION: { level: "error", message: "입력값이 허용 범위·형식을 벗어나 반영되지 않았습니다." },
  EMPLOYEE_REF: { level: "error", message: "존재하지 않거나 확인할 수 없는 직원을 참조하고 있어 반영되지 않았습니다." },
  APPROVAL_FORBIDDEN: { level: "error", message: "결재 승인·반려는 지정된 결재자 본인(또는 관리자)만 할 수 있어 반영되지 않았습니다." },
  CONFIRMED: { level: "error", message: "이미 확정된 항목이라 수정할 수 없습니다." },
  CONFLICT_NEWER: { level: "warn", message: "다른 사용자가 더 최근에 수정한 내용이 우선 적용되어 이 변경은 반영되지 않았습니다." },
  DELETE_FORBIDDEN: { level: "error", message: "삭제 권한이 없거나 삭제할 수 없는 상태(승인·확정·사용 중)라 삭제되지 않았습니다." },
  MODULE_DISABLED: { level: "error", message: "회사에서 사용하지 않도록 설정된 기능이라 저장되지 않았습니다." },
  WELFARE_OVERSPEND: { level: "error", message: "복지포인트 잔액을 초과해 사용할 수 없어 반영되지 않았습니다." },
  TRAINING_CLOSED: { level: "error", message: "마감되었거나 신청할 수 없는 상태의 교육 과정이라 신청이 반영되지 않았습니다." },
  TRAINING_DUPLICATE: { level: "error", message: "이미 같은 과정에 신청한 내역이 있어 중복 신청은 반영되지 않았습니다." },
  TRAINING_COURSE_MISSING: { level: "error", message: "존재하지 않는 교육 과정이라 반영되지 않았습니다." },
  TRAINING_WAITLISTED: { level: "info", message: "정원이 가득 차 대기 신청으로 접수되었습니다." },
  TRAINING_FULL: { level: "error", message: "정원이 가득 차 완료 처리할 수 없습니다." },
  LEARNING_INVALID: { level: "error", message: "입력값이 허용 범위를 벗어났거나 정원·중복 조건에 맞지 않아 반영되지 않았습니다." },
  DEADLINE: { level: "error", message: "평가 마감일이 지나 승인·평가를 변경할 수 없습니다." },
  PARTIAL_FIELDS: { level: "warn", message: "일부 항목이 서버에서 허용되지 않아 이전 값이 유지되었습니다." },
  NOT_SAVED: { level: "error", message: "서버에서 허용되지 않아 저장되지 않았습니다." },
};

function saveRejectInfo(code) {
  const known = REASONS[code] || REASONS.PERMISSION;
  return { reason: REASONS[code] ? code : "PERMISSION", level: known.level, message: known.message };
}

// 서버가 저장하며 스스로 만들거나 정규화하는 메타 필드 — 사용자가 바꾼 값이 아니므로 비교에서 제외한다.
const IGNORED_KEYS = new Set([
  "_rev", "updatedAt", "createdAt", "pw", "authVersion", "adjustmentHistory", "history",
  "enrollmentCounts", "passwordChangedAt",
]);

// 키 순서와 무관하게 값이 같은지 비교하기 위한 안정적 직렬화.
function stableStringify(value) {
  if (value === undefined) return "null";
  // 서버가 id 류를 문자열로 정규화(예: ownerId 1 → "1")하는 것은 사용자가 바꾼 값이 아니므로
  // 숫자·불리언은 문자열과 같은 값으로 취급한다(오탐 방지).
  if (value === null || typeof value !== "object") return typeof value === "number" || typeof value === "boolean" ? JSON.stringify(String(value)) : JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().filter(k => value[k] !== undefined)
    .map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

// 사용자가 보낸 레코드를 깊은 복사로 보관한다(저장 과정에서 원본이 변형돼도 비교가 유지되도록).
function snapshotIntendedRecord(record) {
  const copy = {};
  for (const [key, value] of Object.entries(record || {})) {
    if (!IGNORED_KEYS.has(key)) copy[key] = value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }
  return copy;
}

// 최종 저장본에 존재하는 키 중 사용자가 보낸 값과 달라진 키 목록. 최종본에 키 자체가 없으면
// (읽기 권한으로 숨겨진 필드 등) 비교하지 않는다 — 숨김과 되돌림을 구분할 수 없기 때문이다.
function discrepancyKeys(snapshot, finalRecord) {
  if (!finalRecord) return [];
  const keys = [];
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined || IGNORED_KEYS.has(key)) continue;
    if (!Object.prototype.hasOwnProperty.call(finalRecord, key)) continue;
    if (stableStringify(value) !== stableStringify(finalRecord[key])) keys.push(key);
  }
  return keys;
}

// intended: [{ field, id, isNew, snapshot, incomingUpdatedAt }], lookup(field,id) → 최종 저장본(사용자 시점) 또는 undefined.
// 이미 보고된 (field,id)는 건너뛰고, 침묵 되돌림만 추가 항목으로 만든다. 사유 세분화(마감·확정·
// 더 최신 수정 등)는 서버가 넘기는 hints.partialReason/notSavedReason이 담당한다.
function findSilentRejections(intended, lookup, alreadyReported, hints = {}) {
  const out = [];
  for (const item of intended) {
    const key = `${item.field}\u0000${item.id}`;
    if (alreadyReported.has(key)) continue;
    const finalRecord = lookup(item.field, item.id);
    if (!finalRecord) {
      if (!item.isNew) continue; // 기존 레코드가 안 보이는 것은 삭제·숨김일 수 있어 판단하지 않는다.
      out.push({ field: item.field, id: String(item.id), fields: [], ...saveRejectInfo(hints.notSavedReason?.(item) || "NOT_SAVED") });
      continue;
    }
    const keys = discrepancyKeys(item.snapshot, finalRecord);
    if (!keys.length) continue;
    const reason = hints.partialReason?.(item, finalRecord, keys) || "PARTIAL_FIELDS";
    out.push({ field: item.field, id: String(item.id), fields: keys, ...saveRejectInfo(reason) });
  }
  return out;
}

module.exports = { REASONS, IGNORED_KEYS, saveRejectInfo, stableStringify, snapshotIntendedRecord, discrepancyKeys, findSilentRejections };
