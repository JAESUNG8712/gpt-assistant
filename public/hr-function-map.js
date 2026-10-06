(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.hrFunctionMap = api;
})(typeof window !== "undefined" ? window : null, function () {
  "use strict";

  const ROLE_LANES = [
    { key: "executive", label: "경영진", desc: "인원·인건비·성과·승계 의사결정" },
    { key: "director", label: "임원", desc: "부문 인력·평가·근태 현황" },
    { key: "leader", label: "부서장", desc: "팀 운영·승인·평가" },
    { key: "member", label: "팀원", desc: "내 정보·신청·조회" },
    { key: "hr", label: "인사팀", desc: "기준·원장·급여·감사 운영" },
  ];

  const AREAS = [
    { key: "operations", label: "인사운영", items: [
      ["사원등록·개인기록", "hr-register", "active"], ["발령·변동 이력", "hr-changes", "active"],
      ["증명서 발급", "certificate", "active"], ["온보딩·오프보딩", "onboarding", "active"],
      ["포상·우수사원", "award-history", "active"], ["계약·징계 원장", "", "planned"],
    ] },
    { key: "planning", label: "인사기획", items: [
      ["조직·직급 체계", "settings-org", "active"], ["정원·포지션", "position-control", "active"],
      ["전략적 인력계획", "workforce-planning", "active"], ["핵심직무 승계", "succession-planning", "active"],
      ["인사 통계", "hr-stats", "active"], ["화상조직도·승진 시뮬레이션", "promotion-mgmt", "partial"],
    ] },
    { key: "attendance", label: "근태관리", items: [
      ["근태 기준", "attend-settings", "active"], ["출퇴근·근태", "attendance", "active"],
      ["휴가·연차", "leave-mgmt", "active"], ["초과·탄력근무", "overtime-req", "partial"],
      ["근태 보고서", "hr-attendance", "active"], ["출장 신청·정산", "approval-draft", "partial"],
    ] },
    { key: "learning", label: "교육관리", items: [
      ["법정의무교육", "mandatory-training", "active"], ["직무·스킬 체계", "skills-architecture", "active"],
      ["육성 계획·실적", "talent-dev", "active"], ["교육 과정·강사 마스터", "", "planned"],
      ["교육 신청·비용 정산", "approval-draft", "partial"], ["교육 이력·참여 현황", "hr-mandatory-training", "partial"],
    ] },
    { key: "payroll", label: "급여관리", items: [
      ["급여 기준·계산식", "payroll-settings", "active"], ["급여 계산·조정", "payroll-mgmt", "active"],
      ["급여명세서", "payslip", "active"], ["평가·성과급 연계", "payroll-mgmt", "active"],
      ["인건비 추정", "workforce-planning", "active"], ["호봉·예정임금", "salary-info", "partial"],
    ] },
    { key: "retirement", label: "퇴직관리", items: [
      ["퇴직 체크리스트", "onboarding", "active"], ["예상 퇴직금", "salary-info", "partial"],
      ["퇴직금 정산·지급", "payroll-mgmt", "partial"], ["퇴직연금·계리평가", "integrations", "external"],
      ["퇴직 규정", "board-rules", "partial"], ["퇴직금 추계 보고서", "", "planned"],
    ] },
    { key: "settlement", label: "연말정산관리", items: [
      ["간이 연말정산", "yearend-settlement", "partial"], ["부양가족 자료", "yearend-settlement", "partial"],
      ["급여 원천자료 연계", "yearend-settlement", "active"], ["국세청 간소화 연계", "integrations", "external"],
      ["자료 제출·검증", "yearend-settlement", "partial"], ["법정 신고 파일", "", "planned"],
    ] },
    { key: "insurance", label: "세무·사회보험", items: [
      ["사회보험 기준", "payroll-settings", "partial"], ["취득·상실 신고", "integrations", "external"],
      ["보수월액·소득 신고", "integrations", "external"], ["보험료 급여 반영", "payroll-mgmt", "partial"],
      ["근로내역 확인", "hr-attendance", "partial"], ["보험료 자동산정", "", "planned"],
    ] },
    { key: "welfare", label: "복리후생", items: [
      ["복지 제도 기준", "welfare-settings", "active"], ["경조·학자금 신청", "approval-draft", "active"],
      ["복지포인트", "welfare-points", "active"], ["장기근속 포상", "long-service-award", "active"],
      ["건강검진", "welfare-status", "active"], ["급여 연계", "payroll-mgmt", "active"],
    ] },
  ];

  const FOUNDATION = [
    ["회사정보", "company-info"], ["조직·직급", "settings-org"], ["권한관리", "deploy-perm"],
    ["개인별 메뉴", "deploy-perm"], ["자료 업로드", "data-mgmt"], ["접속·활동 로그", "admin-operations"],
    ["변경 감사로그", "history"], ["외부 시스템 연동", "integrations"],
  ];

  function summary(areas = AREAS) {
    const out = { active: 0, partial: 0, external: 0, planned: 0, total: 0 };
    areas.forEach(area => area.items.forEach(item => { out[item[2]] += 1; out.total += 1; }));
    return out;
  }

  return { ROLE_LANES, AREAS, FOUNDATION, summary };
});

(function attachUi(root) {
  if (!root || !root.document) return;
  const api = root.hrFunctionMap;
  const statusMeta = {
    active: { label: "운영", color: "#15803d", bg: "#dcfce7" },
    partial: { label: "부분", color: "#b45309", bg: "#fef3c7" },
    external: { label: "외부연계", color: "#1d4ed8", bg: "#dbeafe" },
    planned: { label: "고도화", color: "#64748b", bg: "#f1f5f9" },
  };
  const esc = value => typeof root.h === "function" ? root.h(String(value == null ? "" : value)) : String(value == null ? "" : value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const navigate = page => page ? `onclick="gotoPage('${page}')" role="button" tabindex="0" onkeydown="_activateClickable(event)"` : "";

  function render() {
    const c = root.document.getElementById("content");
    if (!c) return;
    if (typeof currentUser === "undefined" || !currentUser || currentUser.role !== "admin") { root._pageAccessDenied(); return; }
    const counts = api.summary();
    const roles = api.ROLE_LANES.map(role => `<div style="border:1px solid #dbe4f0;border-radius:10px;padding:10px;background:#fff"><div class="fw7">${esc(role.label)}</div><div class="fz11 text-gray mt1">${esc(role.desc)}</div></div>`).join("");
    const areas = api.AREAS.map(area => `<section class="card"><div class="card-head"><h3>${esc(area.label)}</h3></div><div class="card-body" style="padding:8px 14px">${area.items.map(([label,page,status]) => { const meta = statusMeta[status]; return `<div ${navigate(page)} style="display:flex;align-items:center;gap:7px;padding:7px 3px;border-bottom:1px solid #f1f5f9;${page ? "cursor:pointer" : ""}"><span style="color:#14b8a6">•</span><span style="flex:1;font-size:12px">${esc(label)}</span><span style="font-size:10px;font-weight:700;color:${meta.color};background:${meta.bg};border-radius:9px;padding:2px 6px">${meta.label}</span></div>`; }).join("")}</div></section>`).join("");
    const foundation = api.FOUNDATION.map(([label,page]) => `<button class="btn btn-secondary btn-sm" onclick="gotoPage('${page}')">${esc(label)}</button>`).join("");
    c.innerHTML = `<div class="flex justify-between items-c mb3" style="gap:12px;flex-wrap:wrap"><div><h2>🧭 HR 업무지도</h2><div class="fz12 text-gray">역할·업무·기준정보·외부 연계를 한 화면에서 점검합니다. 첨부된 HR 기능 구성도를 현재 시스템 기준으로 재구성했습니다.</div></div><button class="btn btn-secondary btn-sm" onclick="gotoPage('admin-operations')">관리자 운영센터</button></div>
      <div class="notice info mb3"><b>상태 기준</b> · 운영: 내부 기능 제공 · 부분: 일부 업무만 지원 · 외부연계: 전문 시스템 연결 필요 · 고도화: 아직 원장 기능 없음</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:9px" class="mb3">${roles}</div>
      <div class="kpi-grid mb3"><div class="kpi-card"><div class="kpi-label">전체 기능</div><div class="kpi-val">${counts.total}</div></div><div class="kpi-card"><div class="kpi-label">운영</div><div class="kpi-val" style="color:#15803d">${counts.active}</div></div><div class="kpi-card"><div class="kpi-label">부분 구현</div><div class="kpi-val" style="color:#b45309">${counts.partial}</div></div><div class="kpi-card"><div class="kpi-label">외부 연계</div><div class="kpi-val" style="color:#1d4ed8">${counts.external}</div></div><div class="kpi-card"><div class="kpi-label">고도화 후보</div><div class="kpi-val" style="color:#64748b">${counts.planned}</div></div></div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px" class="mb3">${areas}</div>
      <div class="card"><div class="card-head"><h3>기준관리·연계·감사</h3></div><div class="card-body flex gap2" style="flex-wrap:wrap">${foundation}</div></div>`;
  }

  root.renderHrFunctionMapPage = render;
})(typeof window !== "undefined" ? window : null);
