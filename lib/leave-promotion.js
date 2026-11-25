// 연차 사용촉진 안내 대상 계산(순수 함수, 서버 전용).
//
// 근로기준법 제61조의 촉진 통보 기간(1차 7/1~7/10, 2차 11/1~11/10)에 미사용 연차가 남은
// 재직자를 찾는다. 잔여 연차 규칙은 클라이언트 public/index.html의 calcAnnualLeaveGrant /
// calcTotalLeaveGrant / calcLeaveUsed 와 같아야 한다(이 파일을 바꾸면 클라이언트도 같이 바꿀 것).
// 날짜는 모두 "YYYY-MM-DD" 문자열의 y/m/d 성분으로만 다뤄 서버 시간대에 영향받지 않는다.
"use strict";

const ymd = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ""));
  return m ? { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) } : null;
};

// 완료된 기간(연) — 생일(기념일)을 지나야 1년이 찬다.
function yearsBetween(start, end) {
  if (!start || !end) return 0;
  let years = end.y - start.y;
  if (end.m < start.m || (end.m === start.m && end.d < start.d)) years--;
  return Math.max(0, years);
}

// 연차 기본 부여일수. 1년 미만은 매월 1일(최대 11일), 1년 이상은 15일에 2년마다 1일 가산(최대 25일).
function annualLeaveGrant(emp, today) {
  const hire = ymd(emp && emp.hire);
  const now = ymd(today);
  if (!hire || !now) return 0;
  const years = yearsBetween(hire, now);
  if (years < 1) {
    let months = (now.y - hire.y) * 12 + (now.m - hire.m);
    if (now.d < hire.d) months--;
    return Math.max(0, Math.min(months, 11));
  }
  return Math.min(15 + Math.floor((years - 1) / 2), 25);
}

// 해당 연도 총 부여일수 = 기본 + 연차 조정(leaveAdjust, 같은 연도 항목 합).
function totalLeaveGrant(emp, year, today) {
  const base = annualLeaveGrant(emp, today);
  const adj = (emp.leaveAdjust || [])
    .filter(a => a && a.year === year)
    .reduce((sum, a) => sum + (Number(a.days) || 0), 0);
  return Math.max(0, base + adj);
}

// 승인된 연차 사용량. 연차는 formData.days(countsAnnual=false면 제외), 반차는 0.5일.
function leaveUsed(empId, approvalDocs) {
  let days = 0;
  for (const d of approvalDocs || []) {
    if (!d || String(d.authorId) !== String(empId) || d.status !== "approved") continue;
    if (d.templateId === "tpl-vacation" && d.formData?.countsAnnual !== false) days += Number(d.formData?.days) || 0;
    else if (d.templateId === "tpl-halfday") days += 0.5;
  }
  return days;
}

// 오늘이 촉진 통보 기간이면 { round, year }, 아니면 null. today는 "YYYY-MM-DD"(한국 날짜).
function promotionWindow(today) {
  const t = ymd(today);
  if (!t) return null;
  const md = `${String(t.m).padStart(2, "0")}-${String(t.d).padStart(2, "0")}`;
  if (md >= "07-01" && md <= "07-10") return { round: 1, year: t.y };
  if (md >= "11-01" && md <= "11-10") return { round: 2, year: t.y };
  return null;
}

// 통보 대상: 재직자 중 잔여 연차가 1일 이상인 사람. 발송 기록 id(noticeId)는 연도·차수·직원으로 고정된다.
function computeLeavePromotionTargets(employees, approvalDocs, today) {
  const win = promotionWindow(today);
  if (!win) return [];
  const out = [];
  for (const e of employees || []) {
    if (!e || !e.active) continue;
    const remain = Math.max(0, totalLeaveGrant(e, win.year, today) - leaveUsed(e.id, approvalDocs));
    if (remain <= 0) continue;
    out.push({
      noticeId: `lpn-${win.year}-${win.round}-${String(e.id)}`,
      year: win.year, round: win.round,
      empId: String(e.id), name: e.name || "", email: e.email || "",
      remain,
    });
  }
  return out;
}

module.exports = {
  annualLeaveGrant, totalLeaveGrant, leaveUsed, promotionWindow, computeLeavePromotionTargets,
};
