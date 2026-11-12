"use strict";
// 예약(미래 발령일) 인사발령의 서버측 반영 계산.
//
// 지금까지 예약발령은 "관리자 브라우저가 열려 있을 때"(로그인, 3분 자동저장, 서버 동기화)만
// 클라이언트의 _applyDueHRChanges()가 반영했다. 발령일이 지나도 아무도 접속하지 않으면
// 부서·직급·퇴직 처리가 그대로여서 급여·권한·결재선이 어긋났다. 서버가 같은 규칙으로
// 도래한 예약발령을 주기적으로 반영하기 위한 순수 함수(저장·잠금은 호출부가 담당한다).
//
// 클라이언트 규칙과 같게 유지하되 다음을 더한다.
//  - pendingUpdates 키는 허용 목록으로 제한한다(role 등 권한 필드는 예약발령으로 바꿀 수 없다).
//  - 부서/팀이 바뀌면 hrHistory 항목에 transferPending/transferFrom을 남긴다. 평가자 자동전환
//    (_autoTransitionCompEvaluators)은 평가 세션·응답 상태를 보는 클라이언트 로직이라 서버가
//    대신 하지 않고, 다음에 접속한 관리자 화면이 이 표식을 보고 처리한 뒤 지운다.
const ALLOWED_PENDING_KEYS = new Set(["dept", "team", "salary", "rank", "position", "active", "retireDate", "retireReason"]);

function sanitizePendingUpdates(pu) {
  const out = {};
  if (!pu || typeof pu !== "object") return out;
  for (const k of Object.keys(pu)) {
    if (!ALLOWED_PENDING_KEYS.has(k)) continue;
    const v = pu[k];
    if (k === "salary") {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > 10_000_000_000) continue;
      out.salary = n;
    } else if (k === "active") {
      if (typeof v === "boolean") out.active = v;
    } else if (v == null || typeof v === "string") {
      out[k] = v == null ? v : v.slice(0, 200);
    }
  }
  return out;
}

// today: "YYYY-MM-DD"(호출부가 한국 날짜 기준으로 계산), nowIso: updatedAt/appliedAt에 쓸 시각.
function computeDueHrChanges(employees, today, nowIso) {
  const applied = [];
  const next = (employees || []).map(e => {
    if (!e || !Array.isArray(e.hrHistory) || !e.hrHistory.length) return e;
    let upd = {};
    let touched = false;
    const hist = e.hrHistory.map(hh => {
      if (!(hh && hh.applied === false && hh.pendingUpdates && typeof hh.date === "string" && hh.date <= today)) return hh;
      let pu = sanitizePendingUpdates(hh.pendingUpdates);
      if (!Object.keys(pu).length) {
        // 허용된 항목이 없으면 반영할 것은 없지만, 매 주기마다 다시 보지 않도록 처리 완료로 표시한다.
        touched = true;
        applied.push({ empId: e.id, histId: hh.id, moved: false });
        return { ...hh, applied: true, appliedBy: "server", appliedAt: nowIso, appliedNote: "허용된 변경 항목 없음" };
      }
      // active:false 전환인데 퇴직일이 없으면 발령일을 퇴직일로 채워 active/retireDate 불일치를 막는다.
      if (pu.active === false && !pu.retireDate && !e.retireDate) pu = { ...pu, retireDate: hh.date };
      const cur = { ...e, ...upd };
      const moved = (pu.dept != null && pu.dept !== cur.dept) || (pu.team != null && pu.team !== cur.team);
      const entry = { ...hh, applied: true, appliedBy: "server", appliedAt: nowIso };
      if (moved) { entry.transferPending = true; entry.transferFrom = { dept: cur.dept || "", team: cur.team || "" }; }
      upd = { ...upd, ...pu };
      touched = true;
      applied.push({ empId: e.id, histId: hh.id, moved });
      return entry;
    });
    return touched ? { ...e, ...upd, hrHistory: hist, updatedAt: nowIso } : e;
  });
  return { employees: next, applied };
}

module.exports = { computeDueHrChanges, sanitizePendingUpdates, ALLOWED_PENDING_KEYS };
