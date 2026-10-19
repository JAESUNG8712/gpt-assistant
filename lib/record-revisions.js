"use strict";
// 수정·삭제 이력(복구용). /save는 전체 상태를 덮어쓰는 구조라, 잘못 수정하거나 삭제한 레코드를
// 되살릴 방법이 연 1회 스냅샷뿐이었다. 저장이 레코드를 바꾸거나 지울 때 "바뀌기 전" 모습을 보관해
// 관리자가 레코드 단위로 복구할 수 있게 한다. 이 모듈은 서버 상태와 무관한 순수 계산만 담는다.

const { stableStringify, snapshotIntendedRecord } = require("./save-feedback");

// 고빈도 로그성/대량 컬렉션은 이력을 남기지 않는다(복구 가치보다 저장 비용이 크다).
const EXCLUDED_FIELDS = new Set(["integrationLogs", "certLog", "attendanceRecords", "workReports", "personalTasks"]);
const KEEP_PER_RECORD = 10;
const MAX_SNAPSHOT_STRING = 100_000; // 사진·첨부(base64) 등 큰 값은 이력에서 제외

function trackedFields(idKeyedFields) {
  return ["employees", "kpiEntries", ...idKeyedFields].filter((f, i, a) => a.indexOf(f) === i && !EXCLUDED_FIELDS.has(f));
}

function _sig(rec) { return `${rec?._rev ?? ""}|${rec?.updatedAt ?? ""}`; }

// 저장 직전에 호출: 이번 요청에 실린 레코드(및 삭제 표시된 id)의 "저장 전" 모습을 문자열로 고정해 둔다.
// 저장 과정에서 원본 객체가 제자리 변경돼도 비교가 유지되도록 객체가 아니라 JSON 문자열로 보관한다.
function takePreImage(storedState, requestBody, fields) {
  const pre = {};
  const tombs = requestBody?.recordTombstones || {};
  for (const field of fields) {
    const wanted = new Set();
    for (const rec of (Array.isArray(requestBody?.[field]) ? requestBody[field] : [])) if (rec && rec.id != null) wanted.add(String(rec.id));
    for (const t of (Array.isArray(tombs[field]) ? tombs[field] : [])) if (t && t.id != null) wanted.add(String(t.id));
    if (!wanted.size) continue;
    const map = new Map();
    for (const rec of (Array.isArray(storedState?.[field]) ? storedState[field] : [])) {
      if (rec && rec.id != null && wanted.has(String(rec.id))) map.set(String(rec.id), { sig: _sig(rec), json: JSON.stringify(rec) });
    }
    if (map.size) pre[field] = map;
  }
  return pre;
}

// 큰 문자열 값과 비밀번호 해시를 제거한 보관용 사본.
function capSnapshot(rec) {
  const out = {};
  const truncated = [];
  for (const [k, v] of Object.entries(rec || {})) {
    if (k === "pw") continue;
    if (typeof v === "string" && v.length > MAX_SNAPSHOT_STRING) { truncated.push(k); continue; }
    out[k] = v;
  }
  if (truncated.length) out._truncatedKeys = truncated;
  return out;
}

function titleOf(rec) {
  return String(rec?.title || rec?.name || rec?.subject || rec?.courseTitle || rec?.label || rec?.docNo || "").slice(0, 80);
}

// preImage와 저장 후 상태를 비교해 보관할 항목을 만든다.
//  - 저장 후 목록에 id가 없으면 operation "delete", 있는데 내용(서버 메타 제외)이 달라졌으면 "update".
//  - 신규 생성은 되돌릴 "이전 모습"이 없으므로 만들지 않는다.
function diffRevisions(preImage, afterState) {
  const out = [];
  for (const [field, map] of Object.entries(preImage || {})) {
    const afterById = new Map();
    for (const rec of (Array.isArray(afterState?.[field]) ? afterState[field] : [])) if (rec && rec.id != null) afterById.set(String(rec.id), rec);
    for (const [id, before] of map) {
      const after = afterById.get(id);
      const prev = JSON.parse(before.json);
      if (!after) { out.push({ field, recordId: id, operation: "delete", title: titleOf(prev), snapshot: capSnapshot(prev) }); continue; }
      if (_sig(after) === before.sig && before.sig !== "|") continue; // 서버 revision·수정시각이 그대로면 변경 없음
      if (stableStringify(snapshotIntendedRecord(prev)) === stableStringify(snapshotIntendedRecord(after))) continue;
      out.push({ field, recordId: id, operation: "update", title: titleOf(prev), snapshot: capSnapshot(prev) });
    }
  }
  return out;
}

module.exports = { EXCLUDED_FIELDS, KEEP_PER_RECORD, trackedFields, takePreImage, diffRevisions, capSnapshot, titleOf };
