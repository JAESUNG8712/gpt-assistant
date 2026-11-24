// 급여 명세서 계산 — 브라우저(index.html)와 서버(server.js)가 같은 파일을 쓴다.
// 계산에 필요한 전역 상태(설정·근태·수당·압류·초과근무)는 전부 ctx 인자로 받으므로
// 어느 쪽에서 호출해도 같은 입력이면 같은 결과가 나온다(단일 계산 원본).
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.PayslipCalc = api;
})(typeof window !== "undefined" ? window : null, function () {
  "use strict";

  // 임원(상무 이상)은 연장근로수당 미지급
  const EXECUTIVE_RANKS = ["상무", "전무", "부사장", "사장", "위원", "상근감사"];
  // 승인된 초과근무 신청 가산율(통상시급 대비)
  const OT_TYPE_MULT = { "연장": 1.5, "야간": 2.0, "휴일": 1.5 };

  function isExecutiveRank(rank) { return EXECUTIVE_RANKS.includes(rank); }

  function ymOf(year, month) { return `${year}-${String(month).padStart(2, "0")}`; }

  // 일 소정근로시간 = (퇴근-출근) - 휴게 1시간 (근로기준법 기준 8시간 표준)
  function calcMonthlyWorkHours(empId, year, month, ctx) {
    const settings = ctx.settings || {};
    const stdDailyHours = Math.max(1, (settings.workEndHour || 18) - (settings.workStartHour || 9) - 1);
    const stdDailyMins = stdDailyHours * 60;
    const ym = ymOf(year, month);
    let regularMins = 0, overtimeMins = 0;
    (ctx.attendanceRecords || []).filter(r => r.empId === empId && r.date.startsWith(ym) && r.checkIn && r.checkOut).forEach(r => {
      const [ih, im] = r.checkIn.split(":").map(Number);
      const [oh, om] = r.checkOut.split(":").map(Number);
      const mins = (oh * 60 + om) - (ih * 60 + im) - 60; // 휴게 1시간 차감
      if (mins <= 0) return;
      regularMins += Math.min(mins, stdDailyMins);
      overtimeMins += Math.max(0, mins - stdDailyMins);
    });
    return { stdDailyHours, regularHours: Math.round(regularMins / 60 * 10) / 10, overtimeHours: Math.round(overtimeMins / 60 * 10) / 10 };
  }

  // D4(호봉제) — payBasisMode==="step"일 때만 직급×직급연차 표를 쓴다. 표가 없거나 해당
  // 직급 행이 비어 있으면 연봉제와 같은 계산으로 폴백한다. 호봉이 표 길이를 넘으면 마지막 호봉.
  function stepMonthlyBase(emp, settings) {
    const steps = ((settings || {}).salaryStepTable || {})[emp.rank];
    if (!Array.isArray(steps) || !steps.length) return Math.round((emp.salary || 0) / 12);
    const idx = Math.min(Math.max(1, Math.round(emp.rankYear || 1)), steps.length) - 1;
    return Number(steps[idx]) || 0;
  }

  function payItemApplies(ci, emp, year, month) {
    if (!ci || ci.enabled === false) return false;
    const ym = ymOf(year, month);
    if (ci.startMonth && ym < ci.startMonth) return false;
    if (ci.endMonth && ym > ci.endMonth) return false;
    const targetType = ci.targetType || "all", targetValue = String(ci.targetValue || "");
    if (targetType === "dept") return !!targetValue && String(emp.dept || "") === targetValue;
    if (targetType === "team") return !!targetValue && String(emp.team || "") === targetValue;
    if (targetType === "rank") return !!targetValue && String(emp.rank || "") === targetValue;
    return targetType === "all";
  }

  function calcPayItemAmount(ci, monthly) {
    const raw = ci.calcType === "monthlyRate" ? monthly * (Number(ci.rate) || 0) / 100 : Number(ci.amount) || 0;
    return Math.max(0, Math.round(raw));
  }

  // 급여 명세서 1건 계산. ctx = { settings, payrollAdjustments, overtimeRequests,
  // wageGarnishments, attendanceRecords } — 누락된 목록은 빈 배열로 취급한다.
  function calcStandardPayslip(emp, year, month, ctx) {
    ctx = ctx || {};
    const settings = ctx.settings || {};
    const payrollAdjustments = ctx.payrollAdjustments || [];
    const meal = 200000;
    const transportIncluded = 100000; // 교통비는 별도 구분 없이 기본급에 포함
    const isResearchAllowTarget = emp.dept === "R&BD센터" && emp.position !== "센터장";
    const researchAllow = isResearchAllowTarget ? 200000 : 0;
    // 연구수당은 현재 연봉 범위 내에서 비과세 항목으로 분리 지급되므로 기본급에서 차감
    const monthlyBase = settings.payBasisMode === "step" ? stepMonthlyBase(emp, settings) : Math.round((emp.salary || 0) / 12);
    const monthly = monthlyBase - researchAllow + transportIncluded;
    const posAllow = emp.position === "팀장" ? 500000 : 0;
    const isExecutive = isExecutiveRank(emp.rank);
    // 회사별 계산식·대상·적용기간을 통과한 항목만 반영한다. 구버전 항목은 고정액/전체
    // 대상으로 해석해 기존 데이터와 계산 결과를 유지한다.
    const customItems = (settings.customPayItems || []).filter(ci => payItemApplies(ci, emp, year, month))
      .slice().sort((a, b) => (Number(a.order) || 999) - (Number(b.order) || 999));
    const customPayItemsList = customItems.filter(ci => ci.type === "pay").map(ci => ({ label: ci.name, amount: calcPayItemAmount(ci, monthly), taxable: ci.taxable !== false, sourceId: ci.id }));
    const customDeductItemsList = customItems.filter(ci => ci.type === "deduct").map(ci => ({ label: ci.name, amount: calcPayItemAmount(ci, monthly), sourceId: ci.id }));
    const customPay = customPayItemsList.reduce((s, ci) => s + ci.amount, 0);
    const customDeduct = customDeductItemsList.reduce((s, ci) => s + ci.amount, 0);
    // 직원별 급여 조정 항목(경조사비/인센티브/추가금액) — 급여 관리 메뉴에서 입력
    const empAdjustments = payrollAdjustments.filter(a => String(a.empId) === String(emp.id) && a.year === year && a.month === month);
    const adjustmentPayItemsList = empAdjustments.filter(a => Number(a.amount) > 0).map(a => ({ label: a.category || "급여 조정", amount: Number(a.amount) || 0, taxable: a.taxable !== false, sourceId: a.id, source: a.source || "manual", note: a.note || "" }));
    const adjustmentDeductItemsList = empAdjustments.filter(a => Number(a.amount) < 0).map(a => ({ label: a.category || "급여 공제", amount: Math.abs(Number(a.amount) || 0), sourceId: a.id, source: a.source || "manual", note: a.note || "" }));
    const adjustPay = adjustmentPayItemsList.reduce((s, a) => s + a.amount, 0), adjustDeduct = adjustmentDeductItemsList.reduce((s, a) => s + a.amount, 0);
    // 시급 및 연장근무 계산 (월 소정근로시간 209시간 기준, 근로기준법) — 임원은 연장근로수당 미지급
    const standardMonthlyHours = 209;
    const hourlyWage = Math.round(monthly / standardMonthlyHours);
    const overtimeHourlyWage = Math.round(hourlyWage * 1.5);
    const { stdDailyHours, regularHours, overtimeHours: rawOvertimeHours } = calcMonthlyWorkHours(emp.id, year, month, ctx);
    const overtimeHours = isExecutive ? 0 : rawOvertimeHours;
    const overtimeAllowance = isExecutive ? 0 : Math.round(overtimeHours * overtimeHourlyWage);
    // 승인된 초과근무 신청(연장 1.5/야간 2.0/휴일 1.5배) — 승인된 건만 반영
    const monthPrefix = ymOf(year, month);
    const otReqs = isExecutive ? [] : (ctx.overtimeRequests || []).filter(r => String(r.empId) === String(emp.id) && r.status === "approved" && String(r.date || "").startsWith(monthPrefix));
    const otReqHours = otReqs.reduce((s, r) => s + (r.hours || 0), 0);
    const otReqAllowance = Math.round(otReqs.reduce((s, r) => s + (r.hours || 0) * hourlyWage * (OT_TYPE_MULT[r.type] || 1.5), 0));
    const transport = 0;
    const gross = monthly + meal + researchAllow + posAllow + customPay + overtimeAllowance + otReqAllowance + adjustPay;
    // 지급 항목 상세 분류 (식대·연구수당은 비과세, 그 외는 과세 — 과세 항목 합계가 4대보험·소득세 산정 기준)
    const payItems = [
      { label: "기본급", amount: monthly, taxable: true },
      ...(overtimeAllowance > 0 ? [{ label: `연장근로수당(${overtimeHours}h)`, amount: overtimeAllowance, taxable: true }] : []),
      ...(otReqAllowance > 0 ? [{ label: `초과근무수당(신청 ${otReqHours}h)`, amount: otReqAllowance, taxable: true }] : []),
      { label: "식대", amount: meal, taxable: false },
      ...(researchAllow > 0 ? [{ label: "연구수당", amount: researchAllow, taxable: false }] : []),
      ...(posAllow > 0 ? [{ label: "직책수당", amount: posAllow, taxable: true }] : []),
      ...customPayItemsList.filter(ci => ci.amount > 0),
      ...adjustmentPayItemsList,
    ];
    const taxableIncome = payItems.filter(it => it.taxable).reduce((s, it) => s + it.amount, 0);
    const pension = Math.round(taxableIncome * 0.045);
    const health = Math.round(taxableIncome * 0.03545);
    const care = Math.round(taxableIncome * 0.00453);
    const employ = Math.round(taxableIncome * 0.009);
    let tax = 0;
    if (taxableIncome >= 8000000) tax = Math.round(taxableIncome * 0.24);
    else if (taxableIncome >= 5000000) tax = Math.round(taxableIncome * 0.15);
    else if (taxableIncome >= 3000000) tax = Math.round(taxableIncome * 0.06);
    else tax = Math.round(taxableIncome * 0.02);
    const localTax = Math.round(tax * 0.1);
    const baseTotalDeduct = pension + health + care + employ + tax + localTax + customDeduct + adjustDeduct;
    // D4(급여압류등록) — 활성 압류명령만 반영. 민사집행법상 압류금지 최저생계비 등 법정
    // 세부규정은 반영하지 않는 참고용 계산이며, 화면에도 안내 문구로 명시한다.
    const monthKey = ymOf(year, month);
    const activeGarnishments = (ctx.wageGarnishments || []).filter(g => String(g.empId) === String(emp.id) && g.status !== "canceled" && g.status !== "completed" && (!g.startMonth || monthKey >= g.startMonth) && (!g.endMonth || monthKey <= g.endMonth));
    const preGarnishNet = gross - baseTotalDeduct;
    const garnishDeductItemsList = activeGarnishments.map(g => ({ label: `급여압류(${g.caseNumber || g.creditor || "법원명령"})`, amount: g.type === "percentOfNet" ? Math.max(0, Math.round(preGarnishNet * (Number(g.rate) || 0) / 100)) : Math.max(0, Math.round(Number(g.amount) || 0)), sourceId: g.id }));
    const garnishDeduct = garnishDeductItemsList.reduce((s, gi) => s + gi.amount, 0);
    const totalDeduct = baseTotalDeduct + garnishDeduct;
    const deductItems = [
      { label: "국민연금 (4.5%)", amount: pension },
      { label: "건강보험 (3.545%)", amount: health },
      { label: "장기요양보험 (0.453%)", amount: care },
      { label: "고용보험 (0.9%)", amount: employ },
      { label: "소득세", amount: tax },
      { label: "지방소득세(주민세) (10%)", amount: localTax },
      ...customDeductItemsList.filter(ci => ci.amount > 0),
      ...adjustmentDeductItemsList,
      ...garnishDeductItemsList,
    ];
    // id는 결정적(사번+연+월). payslips는 id 기준으로 병합되므로 id가 없으면 저장 때 조용히 사라진다.
    return {
      id: `payslip-${emp.id}-${year}-${month}`, empId: emp.id, year, month, gross, monthly, meal, transport, researchAllow, posAllow, customPay, customDeduct, adjustPay, adjustDeduct, garnishDeduct, adjustItems: empAdjustments,
      payItems, deductItems, taxableIncome,
      standardMonthlyHours, hourlyWage, overtimeHourlyWage, stdDailyHours, regularHours, overtimeHours, overtimeAllowance,
      pension, health, care, employ, tax, localTax, totalDeduct, netPay: gross - totalDeduct, confirmed: false, confirmedAt: null, updatedAt: new Date().toISOString(),
    };
  }

  return {
    EXECUTIVE_RANKS, OT_TYPE_MULT, isExecutiveRank,
    calcMonthlyWorkHours, stepMonthlyBase, payItemApplies, calcPayItemAmount, calcStandardPayslip,
  };
});
