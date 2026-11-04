"use strict";
// 수정·삭제 이력(복구용). /save는 전체 상태를 덮어쓰는 구조라, 잘못 수정하거나 삭제한 레코드를
// 되살릴 방법이 연 1회 스냅샷뿐이었다. 저장이 레코드를 바꾸거나 지울 때 "바뀌기 전" 모습을 보관해
// 관리자가 레코드 단위로 복구할 수 있게 한다. 이 모듈은 서버 상태와 무관한 순수 계산만 담는다.

const { stableStringify, snapshotIntendedRecord } = require("./save-feedback");

// 고빈도 로그성/대량 컬렉션은 이력을 남기지 않는다(복구 가치보다 저장 비용이 크다).
const EXCLUDED_FIELDS = new Set(["integrationLogs", "certLog", "attendanceRecords", "workReports", "personalTasks"]);
const KEEP_PER_RECORD = 10;
const MAX_SNAPSHOT_STRING = 100_000; // 사진·첨부(base64) 등 큰 값은 이력에서 제외
const MAX_SNAPSHOT_BYTES = 262144;
const EMPLOYEE_AUTH_FIELDS = ["pw", "authVersion", "twoFactorSecret", "twoFactorEnabled",
  "passwordChangedAt", "mustChangePassword", "passwordResetRequired"];
const SECRET_KEYS = new Set([
  ...EMPLOYEE_AUTH_FIELDS, "password", "passwordHash", "hashedPassword", "secret",
  "token", "accessToken", "refreshToken", "apiKey", "apiSecret", "clientSecret",
  "sessionSecret", "totpSecret", "recoveryCodes", "backupCodes", "authorization",
  "cookie", "setCookie", "privateKey", "databaseUrl", "connectionString",
].map(key => key.replace(/[_\s-]/g, "").toLowerCase()));

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

// Bound the entire tree, not just top-level strings. Mark omitted business data
// so restore cannot replace the live record with an incomplete snapshot.
function capSnapshot(rec) {
  const truncated = [], redacted = [], omit = Symbol("omit");
  const mark = (list, key) => {
    const value = String(key).slice(0, 256);
    if (!list.includes(value) && list.length < 64) list.push(value);
  };
  for (const [key, list] of [["_truncatedKeys", truncated], ["_redactedKeys", redacted]]) {
    if (Array.isArray(rec?.[key])) for (const path of rec[key]) {
      if (typeof path === "string") mark(list, path);
    }
  }
  let nodes = 0, bytes = 0;
  const visit = (value, path, depth) => {
    if (++nodes > 10000 || depth > 32 || bytes > MAX_SNAPSHOT_BYTES) { mark(truncated, path || "$"); return omit; }
    if (typeof value === "string" && value.length > MAX_SNAPSHOT_STRING) { mark(truncated, path); return omit; }
    if (value === null || typeof value !== "object") {
      bytes += Buffer.byteLength(JSON.stringify(value) || "null");
      if (bytes > MAX_SNAPSHOT_BYTES) { mark(truncated, path); return omit; }
      return value;
    }
    const result = Array.isArray(value) ? [] : {};
    for (const [key, child] of Object.entries(value)) {
      if (!path && ["_truncatedKeys", "_redactedKeys"].includes(key)) continue;
      const nextPath = path ? `${path}.${key.replace(/[.\\]/g, "\\$&")}` : key.replace(/[.\\]/g, "\\$&");
      if (SECRET_KEYS.has(key.replace(/[_\s-]/g, "").toLowerCase()) ||
          ["__proto__", "constructor", "prototype"].includes(key)) { mark(redacted, nextPath); continue; }
      bytes += Buffer.byteLength(JSON.stringify(key)) + 4;
      const next = visit(child, nextPath, depth + 1);
      if (Array.isArray(result)) result.push(next === omit ? null : next);
      else if (next !== omit) result[key] = next;
      if (nodes > 10000 || bytes > MAX_SNAPSHOT_BYTES) { mark(truncated, path || "$"); break; }
    }
    return result;
  };
  let out = visit(rec || {}, "", 0);
  if (!out || out === omit || Array.isArray(out) || typeof out !== "object") out = {};
  if (truncated.length) out._truncatedKeys = truncated;
  if (redacted.length) out._redactedKeys = redacted;
  if (Buffer.byteLength(JSON.stringify(out)) > MAX_SNAPSHOT_BYTES) {
    return { _truncatedKeys: ["$"], ...(redacted.length ? { _redactedKeys: redacted } : {}) };
  }
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

module.exports = { EXCLUDED_FIELDS, KEEP_PER_RECORD, EMPLOYEE_AUTH_FIELDS, trackedFields, takePreImage, diffRevisions, capSnapshot, titleOf };
