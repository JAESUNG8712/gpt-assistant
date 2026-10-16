(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.learningCenterTools = api;
})(typeof window !== "undefined" ? window : null, function () {
  "use strict";
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const validDate = value => { const s=String(value||""); if(!DATE_RE.test(s))return false; const d=new Date(`${s}T00:00:00Z`); return !Number.isNaN(d.getTime())&&d.toISOString().slice(0,10)===s; };
  const clean = (value, max) => String(value == null ? "" : value).trim().slice(0, max);

  function validateCourse(c) {
    const errors = [];
    if (!clean(c?.name, 120)) errors.push("과정명을 입력하세요.");
    if (!clean(c?.category, 80)) errors.push("교육 분류를 입력하세요.");
    if (!validDate(c?.startDate) || !validDate(c?.endDate)) errors.push("교육 시작일과 종료일을 입력하세요.");
    else if (c.endDate < c.startDate) errors.push("교육 종료일은 시작일보다 빠를 수 없습니다.");
    const hours = Number(c?.hours), capacity = Number(c?.capacity), cost = Number(c?.cost || 0);
    if (!Number.isFinite(hours) || hours <= 0 || hours > 1000) errors.push("교육시간은 0 초과 1,000시간 이하로 입력하세요.");
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 10000) errors.push("정원은 1~10,000명으로 입력하세요.");
    if (!Number.isFinite(cost) || cost < 0 || cost > 1_000_000_000) errors.push("비용을 확인하세요.");
    return { ok: errors.length === 0, errors };
  }

  function validateAssignment(a, courses, assignments, editingId) {
    const errors = [], course = (courses || []).find(c => String(c.id) === String(a?.courseId));
    if (!course) errors.push("교육 과정을 선택하세요.");
    if (!clean(a?.empId, 120)) errors.push("직원을 선택하세요.");
    if (!validDate(a?.assignedAt)) errors.push("배정일을 입력하세요.");
    if (a?.dueDate && (!validDate(a.dueDate) || a.dueDate < a.assignedAt)) errors.push("이수기한은 배정일보다 빠를 수 없습니다.");
    if ((assignments || []).some(x => String(x.id) !== String(editingId || "") && String(x.courseId) === String(a?.courseId) && String(x.empId) === String(a?.empId) && x.status !== "cancelled")) errors.push("같은 직원에게 이미 배정된 과정입니다.");
    if (course) {
      const used = (assignments || []).filter(x => String(x.id) !== String(editingId || "") && String(x.courseId) === String(course.id) && x.status !== "cancelled").length;
      if (used >= Number(course.capacity || 0)) errors.push("과정 정원이 모두 찼습니다.");
    }
    const score = a?.score === "" || a?.score == null ? null : Number(a.score);
    if (score != null && (!Number.isFinite(score) || score < 0 || score > 100)) errors.push("점수는 0~100으로 입력하세요.");
    const cost = Number(a?.approvedCost || 0);
    if (!Number.isFinite(cost) || cost < 0 || cost > 1_000_000_000) errors.push("승인 비용을 확인하세요.");
    if (!["not_required", "pending", "settled"].includes(a?.settlementStatus || "not_required")) errors.push("비용 정산 상태를 확인하세요.");
    if (a?.settledAt && !validDate(a.settledAt)) errors.push("정산일을 확인하세요.");
    if (a?.settlementStatus === "settled" && (a?.settledAmount === "" || a?.settledAmount == null)) errors.push("정산 완료 시 실제 정산액을 입력하세요.");
    if (a?.settledAmount != null && (!Number.isFinite(Number(a.settledAmount)) || Number(a.settledAmount) < 0 || Number(a.settledAmount) > 1_000_000_000)) errors.push("실제 정산액을 확인하세요.");
    return { ok: errors.length === 0, errors };
  }

  function validateSettlement(a) {
    const errors = [];
    if (!["not_required", "pending", "settled"].includes(a?.settlementStatus)) errors.push("비용 정산 상태를 확인하세요.");
    if (a?.settledAt && !validDate(a.settledAt)) errors.push("정산일을 확인하세요.");
    if (a?.settlementStatus === "settled" && (a?.settledAmount === "" || a?.settledAmount == null)) errors.push("정산 완료 시 실제 정산액을 입력하세요.");
    if (a?.settledAmount != null && (!Number.isFinite(Number(a.settledAmount)) || Number(a.settledAmount) < 0 || Number(a.settledAmount) > 1_000_000_000)) errors.push("실제 정산액을 확인하세요.");
    return { ok: errors.length === 0, errors };
  }

  function summarize(courses, assignments, empId, today = new Date().toISOString().slice(0, 10)) {
    const cs = Array.isArray(courses) ? courses : [], all = Array.isArray(assignments) ? assignments : [];
    const rows = empId == null ? all : all.filter(a => String(a.empId) === String(empId));
    const soon = new Date(`${today}T00:00:00Z`); soon.setUTCDate(soon.getUTCDate() + 7);
    const soonDate = soon.toISOString().slice(0, 10);
    return { activeCourses: cs.filter(c => c.status === "active").length, assigned: rows.filter(a => a.status === "assigned" || a.status === "in_progress").length,
      completed: rows.filter(a => a.status === "completed").length, overdue: rows.filter(a => a.status !== "completed" && a.status !== "cancelled" && a.dueDate && a.dueDate < today).length,
      dueSoon: rows.filter(a => a.status !== "completed" && a.status !== "cancelled" && a.dueDate && a.dueDate >= today && a.dueDate <= soonDate).length,
      pendingSettlement: rows.filter(a => a.settlementStatus === "pending").length,
      approvedCost: rows.reduce((sum, a) => sum + (Number(a.approvedCost) || 0), 0),
      settledCost: rows.filter(a => a.settlementStatus === "settled").reduce((sum, a) => sum + (Number(a.settledAmount ?? a.approvedCost) || 0), 0) };
  }
  function combinedHistory(courses, assignments, directCourses, enrollments, empId) {
    const assignedById = new Map((courses || []).map(c => [String(c.id), c]));
    const directById = new Map((directCourses || []).map(c => [String(c.id), c]));
    const visible = row => empId == null || String(row.empId) === String(empId);
    const rows = [
      ...(assignments || []).filter(a => a && visible(a)).map(a => {
        const course = assignedById.get(String(a.courseId));
        return { source: "배정·결재", id: String(a.id), empId: String(a.empId), courseName: course?.name || "삭제된 과정",
          status: a.status || "", startDate: course?.startDate || "", endDate: course?.endDate || "",
          completedAt: a.completedAt || "", sortDate: a.completedAt || a.assignedAt || course?.startDate || "" };
      }),
      ...(enrollments || []).filter(e => e && visible(e)).map(e => {
        const course = directById.get(String(e.courseId));
        return { source: "직접 신청", id: String(e.id), empId: String(e.empId), courseName: course?.title || "삭제된 과정",
          status: e.status || "", startDate: course?.startDate || "", endDate: course?.endDate || "",
          completedAt: e.completedAt || "", sortDate: e.completedAt || e.appliedAt || course?.startDate || "" };
      }),
    ];
    // 서로 다른 원장의 같은 이름 과정은 동일하다고 단정할 수 없어 합치거나 비용을 더하지 않는다.
    return rows.sort((a, b) => String(b.sortDate).localeCompare(String(a.sortDate)) || a.source.localeCompare(b.source));
  }
  return { validateCourse, validateAssignment, validateSettlement, summarize, combinedHistory };
});

(function attachUi(root) {
  if (!root || !root.document) return;
  const tools = root.learningCenterTools, esc = value => h(String(value == null ? "" : value));
  const courseOf = id => learningCourses.find(c => String(c.id) === String(id));
  const empOf = id => employees.find(e => String(e.id) === String(id));
  const statusText = { draft: "초안", active: "운영", closed: "종료", assigned: "배정", in_progress: "수강 중", completed: "이수", cancelled: "취소" };
  let editingCourseId = null, editingAssignmentId = null;
  const listFilter = { query: "", courseStatus: "all", assignmentStatus: "all", page: 1 };
  const PAGE_SIZE = 25;
  const money = value => (Number(value) || 0).toLocaleString("ko-KR");

  function courseEditor(id) {
    if (currentUser?.role !== "admin") return _pageAccessDenied();
    editingCourseId = id == null ? null : String(id);
    root.gotoPage("learning-course-edit");
  }

  function renderCourseEditor() {
    if (currentUser?.role !== "admin") return _pageAccessDenied();
    const old = editingCourseId == null ? null : courseOf(editingCourseId);
    if (editingCourseId != null && !old) { root.gotoPage("learning-center"); showToast("교육 과정을 찾을 수 없습니다.","error"); return; }
    const c = old || { name: "", category: "직무", provider: "", instructorName: "", delivery: "offline", startDate: "", endDate: "", hours: 8, capacity: 20, cost: 0, status: "draft", description: "", internalNote: "" };
    const readOnly = old?.status === "closed";
    const body = `${readOnly?'<div class="info-note mb3">종료된 과정은 원장 기준정보를 수정할 수 없습니다.</div><fieldset disabled style="border:0;padding:0;margin:0">':''}<div class="info-note mb3">과정 일정과 정원을 먼저 등록한 뒤 직원에게 배정하세요. 과정 종료 후에는 기준정보를 수정할 수 없습니다.</div>
    <div class="form-grid"><div class="fg"><label class="fl">과정명 *</label><input id="lc-name" maxlength="120" value="${esc(c.name)}" placeholder="예: 신임 팀장 리더십 과정"></div><div class="fg"><label class="fl">분류 *</label><input id="lc-category" maxlength="80" value="${esc(c.category)}" placeholder="예: 리더십 / 직무 / 안전"></div>
    <div class="fg"><label class="fl">교육기관</label><input id="lc-provider" maxlength="120" value="${esc(c.provider)}" placeholder="예: 사내 HRD / 한국생산성본부"></div><div class="fg"><label class="fl">강사</label><input id="lc-instructor" maxlength="80" value="${esc(c.instructorName)}" placeholder="예: 홍길동 수석강사"></div>
    <div class="fg"><label class="fl">방식</label><select id="lc-delivery"><option value="offline" ${c.delivery === "offline" ? "selected" : ""}>집합</option><option value="online" ${c.delivery === "online" ? "selected" : ""}>온라인</option><option value="blended" ${c.delivery === "blended" ? "selected" : ""}>혼합</option></select></div><div class="fg"><label class="fl">상태</label><select id="lc-status">${["draft","active","closed"].map(v => `<option value="${v}" ${c.status === v ? "selected" : ""}>${statusText[v]}</option>`).join("")}</select></div>
    <div class="fg"><label class="fl">시작일 *</label><input id="lc-start" type="date" value="${esc(c.startDate)}"></div><div class="fg"><label class="fl">종료일 *</label><input id="lc-end" type="date" value="${esc(c.endDate)}"></div>
    <div class="fg"><label class="fl">교육시간 *</label><input id="lc-hours" type="number" min="0.5" max="1000" step="0.5" value="${esc(c.hours)}"></div><div class="fg"><label class="fl">정원 *</label><input id="lc-capacity" type="number" min="1" max="10000" value="${esc(c.capacity)}"></div>
    <div class="fg"><label class="fl">1인 비용(원)</label><input id="lc-cost" type="number" min="0" max="1000000000" value="${esc(c.cost)}"></div></div>
    <div class="fg"><label class="fl">과정 설명</label><textarea id="lc-description" maxlength="1000" rows="3" placeholder="예: 팀장 역할 전환과 성과 코칭 실습">${esc(c.description)}</textarea></div><div class="fg"><label class="fl">관리자 메모</label><textarea id="lc-note" maxlength="500" rows="2" placeholder="일반 직원에게는 표시되지 않습니다.">${esc(c.internalNote)}</textarea></div><div id="lc-errors" class="alert alert-error" role="alert" style="display:none"></div>${readOnly?"</fieldset>":""}`;
    root.renderWorkspaceFormPage({title:readOnly?"종료된 교육 과정":old?"교육 과정 수정":"교육 과정 등록",description:"일정·정원·교육비를 등록하면 신청과 수강 배정에 연결됩니다.",backPage:"learning-center",body,saveAction:readOnly?null:"saveLearningCourse()"});
  }

  async function saveCourse(id) {
    const targetId = id == null ? editingCourseId : String(id);
    const old = targetId == null ? null : courseOf(targetId);
    if (targetId != null && !old) { showToast("교육 과정을 다시 확인하세요.","error"); return; }
    if (old?.status === "closed") { showToast("종료된 과정은 수정할 수 없습니다.","error"); return; }
    const input = { id: old?.id || genId(), name: $("#lc-name")?.value, category: $("#lc-category")?.value, provider: $("#lc-provider")?.value, instructorName: $("#lc-instructor")?.value,
      delivery: $("#lc-delivery")?.value, status: $("#lc-status")?.value, startDate: $("#lc-start")?.value, endDate: $("#lc-end")?.value,
      hours: Number($("#lc-hours")?.value), capacity: Number($("#lc-capacity")?.value), cost: Number($("#lc-cost")?.value || 0), description: $("#lc-description")?.value, internalNote: $("#lc-note")?.value };
    const check = tools.validateCourse(input), box = $("#lc-errors"); if (!check.ok) { box.style.display="block"; box.innerHTML=check.errors.map(esc).join("<br>"); return; }
    const assigned = learningAssignments.filter(a => String(a.courseId) === String(input.id) && a.status !== "cancelled").length;
    if (input.capacity < assigned) { box.style.display="block"; box.textContent=`이미 ${assigned}명이 배정되어 정원을 그보다 작게 줄일 수 없습니다.`; return; }
    const ok = await askConfirmModal({ title: old ? "교육 과정 수정" : "교육 과정 등록", message: `‘${input.name}’ 과정을 저장합니다.`, confirmText:"저장", impacts:[{label:"기간",value:`${input.startDate} ~ ${input.endDate}`},{label:"정원",value:`${input.capacity}명`},{label:"현재 배정",value:`${assigned}명`} ] }); if(!ok)return;
    const now=new Date().toISOString(), next={...old,...input,createdAt:old?.createdAt||now,createdBy:old?.createdBy||currentUser.id,updatedAt:now,updatedBy:currentUser.id};
    if(old)learningCourses=learningCourses.map(c=>String(c.id)===String(old.id)?next:c);else learningCourses.push(next);
    root.queueTrackedSave("교육 과정");root.gotoPage("learning-center");
  }

  function assignmentEditor(id) {
    if (currentUser?.role !== "admin") return _pageAccessDenied();
    editingAssignmentId = id == null ? null : String(id);
    root.gotoPage("learning-assignment-edit");
  }

  function renderAssignmentEditor() {
    if (currentUser?.role !== "admin") return _pageAccessDenied();
    const old=editingAssignmentId == null ? null : learningAssignments.find(a=>String(a.id)===editingAssignmentId);
    if (editingAssignmentId != null && !old) { root.gotoPage("learning-center"); showToast("교육 배정을 찾을 수 없습니다.","error"); return; }
    const a=old||{courseId:"",empId:"",status:"assigned",assignedAt:new Date().toISOString().slice(0,10),dueDate:"",score:"",certificateNo:"",evidenceRef:"",note:"",approvedCost:0,costCenter:"",settlementStatus:"not_required",settledAt:"",settledAmount:0,settlementNote:""};
    const approved=a.source==="approval", completed=a.status==="completed", lockCore=approved||completed;
    const courses=learningCourses.filter(c=>c.status!=="closed"||String(c.id)===String(a.courseId)).map(c=>`<option value="${esc(c.id)}" ${String(c.id)===String(a.courseId)?"selected":""}>${esc(c.name)} · ${esc(c.startDate)}~${esc(c.endDate)}</option>`).join("");
    const emps=employees.filter(e=>e.active!==false||String(e.id)===String(a.empId)).map(e=>`<option value="${esc(e.id)}" ${String(e.id)===String(a.empId)?"selected":""}>${esc(e.name)} (${esc(e.empNo||"-")}) · ${esc(e.dept||"-")}</option>`).join("");
    const body=`${approved?'<div class="info-note mb3">결재로 확정된 과정·직원·기간·승인비용은 변경할 수 없습니다. 수강 상태와 수료 증빙, 정산만 처리하세요.</div>':""}${completed?'<div class="info-note mb3">수료 이력이 확정되었습니다. 이후에는 정산 항목만 수정할 수 있습니다.</div>':""}
      <div class="form-grid"><div class="fg"><label class="fl">과정 *</label><select id="la-course" ${lockCore?"disabled":""}><option value="">선택</option>${courses}</select></div><div class="fg"><label class="fl">직원 *</label><select id="la-emp" ${old?"disabled":""}><option value="">선택</option>${emps}</select></div>
      <div class="fg"><label class="fl">배정일 *</label><input id="la-assigned" type="date" value="${esc(a.assignedAt)}" ${lockCore?"disabled":""}></div><div class="fg"><label class="fl">이수기한</label><input id="la-due" type="date" value="${esc(a.dueDate)}" ${lockCore?"disabled":""}></div>
      <div class="fg"><label class="fl">상태</label><select id="la-status" ${completed?"disabled":""}>${["assigned","in_progress","completed","cancelled"].map(v=>`<option value="${v}" ${a.status===v?"selected":""}>${statusText[v]}</option>`).join("")}</select></div><div class="fg"><label class="fl">점수</label><input id="la-score" type="number" min="0" max="100" value="${esc(a.score??"")}" placeholder="예: 85" ${completed?"disabled":""}></div>
      <div class="fg"><label class="fl">수료번호</label><input id="la-cert" maxlength="120" value="${esc(a.certificateNo)}" placeholder="예: CERT-2026-001" ${completed?"disabled":""}></div><div class="fg"><label class="fl">수료 증빙 참조</label><input id="la-evidence" maxlength="200" value="${esc(a.evidenceRef)}" placeholder="예: 문서번호 EDU-2026-001" ${completed?"disabled":""}></div>
      <div class="fg"><label class="fl">승인 비용(원)</label><input id="la-cost" type="number" min="0" max="1000000000" value="${esc(a.approvedCost||0)}" placeholder="예: 350000" ${lockCore?"disabled":""}></div><div class="fg"><label class="fl">실제 정산액(원)</label><input id="la-settled-amount" type="number" min="0" max="1000000000" value="${esc(a.settledAmount??(a.settlementStatus==="settled"?a.approvedCost:0))}" placeholder="예: 340000"></div>
      <div class="fg"><label class="fl">비용 귀속</label><input id="la-cost-center" maxlength="100" value="${esc(a.costCenter)}" placeholder="예: 경영지원팀" ${lockCore?"disabled":""}></div><div class="fg"><label class="fl">정산 상태</label><select id="la-settlement"><option value="not_required" ${a.settlementStatus==="not_required"?"selected":""}>정산 없음</option><option value="pending" ${a.settlementStatus==="pending"?"selected":""}>정산 대기</option><option value="settled" ${a.settlementStatus==="settled"?"selected":""}>정산 완료</option></select></div>
      <div class="fg"><label class="fl">정산일</label><input id="la-settled-at" type="date" value="${esc(a.settledAt)}"></div></div><div class="fg"><label class="fl">메모</label><textarea id="la-note" maxlength="500" rows="2" ${completed?"disabled":""}>${esc(a.note)}</textarea></div><div class="fg"><label class="fl">정산 메모</label><textarea id="la-settlement-note" maxlength="500" rows="2" placeholder="예: 법인카드 전표 2026-001 확인">${esc(a.settlementNote)}</textarea></div><div id="la-errors" class="alert alert-error" role="alert" style="display:none"></div>`;
    root.renderWorkspaceFormPage({title:old?"교육 배정·정산 수정":"직원 교육 배정",description:"배정 후 수료를 확정하면 직원 교육이력에 반영됩니다.",backPage:"learning-center",body,saveAction:"saveLearningAssignment()"});
    if (a.settlementStatus !== "settled" && $("#la-settled-amount")) $("#la-settled-amount").value = "";
  }

  async function saveAssignment(id) {
    const targetId=id == null ? editingAssignmentId : String(id);
    const old=targetId == null ? null : learningAssignments.find(a=>String(a.id)===targetId);
    if(targetId != null && !old){showToast("교육 배정을 다시 확인하세요.","error");return;}
    const input={id:old?.id||genId(),courseId:$("#la-course")?.value,empId:old?.empId||$("#la-emp")?.value,status:$("#la-status")?.value,assignedAt:$("#la-assigned")?.value,dueDate:$("#la-due")?.value,score:$("#la-score")?.value,certificateNo:$("#la-cert")?.value,evidenceRef:$("#la-evidence")?.value,note:$("#la-note")?.value,approvedCost:Number($("#la-cost")?.value||0),costCenter:$("#la-cost-center")?.value,settlementStatus:$("#la-settlement")?.value,settledAt:$("#la-settled-at")?.value,settledAmount:$("#la-settled-amount")?.value,settlementNote:$("#la-settlement-note")?.value};
    if(old?.source==="approval")Object.assign(input,{courseId:old.courseId,empId:old.empId,assignedAt:old.assignedAt,dueDate:old.dueDate,approvedCost:old.approvedCost,costCenter:old.costCenter});
    if(old?.status==="completed")Object.assign(input,{courseId:old.courseId,empId:old.empId,status:old.status,assignedAt:old.assignedAt,dueDate:old.dueDate,score:old.score,certificateNo:old.certificateNo,evidenceRef:old.evidenceRef,note:old.note,approvedCost:old.approvedCost,costCenter:old.costCenter});
    const box=$("#la-errors"),check=old?.status==="completed"?tools.validateSettlement(input):tools.validateAssignment(input,learningCourses,learningAssignments,old?.id);
    if(!check.ok){box.style.display="block";box.innerHTML=check.errors.map(esc).join("<br>");return;}
    const c=courseOf(input.courseId),e=empOf(input.empId),ok=await askConfirmModal({title:old?.status==="completed"?"교육비 정산 수정":old?"교육 배정 수정":"교육 배정",message:`${e?.name||"선택 직원"}의 ‘${c?.name||"과정"}’ 내용을 저장합니다.`,confirmText:"저장",impacts:[{label:"직원",value:e?.name||"-"},{label:"과정",value:c?.name||"-"},{label:"상태",value:statusText[input.status]},{label:"정산",value:{not_required:"없음",pending:"대기",settled:"완료"}[input.settlementStatus]}]});if(!ok)return;
    const now=new Date().toISOString(),settledAt=input.settlementStatus==="settled"?(input.settledAt||now.slice(0,10)):"",settledAmount=input.settlementStatus==="settled"?Number(input.settledAmount):0;
    const next=old?.status==="completed"?{...old,settlementStatus:input.settlementStatus,settledAt,settledAmount,settlementNote:input.settlementNote,updatedAt:now,updatedBy:currentUser.id}:{...old,...input,score:input.score===""?null:Number(input.score),completedAt:input.status==="completed"?(old?.completedAt||now.slice(0,10)):"",settledAt,settledAmount,createdAt:old?.createdAt||now,createdBy:old?.createdBy||currentUser.id,updatedAt:now,updatedBy:currentUser.id};
    if(old)learningAssignments=learningAssignments.map(a=>String(a.id)===String(old.id)?next:a);else learningAssignments.push(next);
    if(next.status==="completed"&&old?.status!=="completed"&&e){const historyId=`learning-${next.id}`,hist={id:historyId,type:"edu_general",desc:c?.name||"교육 이수",name:c?.name||"",institution:c?.provider||"",date:next.completedAt,startDate:c?.startDate||"",endDate:c?.endDate||"",note:`${c?.hours||0}시간${next.certificateNo?` · 수료번호 ${next.certificateNo}`:""}`,createdAt:now};e.hrHistory=[...(e.hrHistory||[]).filter(h=>String(h.id)!==historyId),hist];e.updatedAt=now;}
    root.queueTrackedSave(old?.status==="completed"?"교육비 정산":"교육 배정·이력");root.gotoPage("learning-center");
  }

  function visibleAssignments() {
    const admin = currentUser?.role === "admin", today = new Date().toISOString().slice(0, 10);
    const soon = new Date(`${today}T00:00:00Z`); soon.setUTCDate(soon.getUTCDate() + 7);
    const soonDate = soon.toISOString().slice(0, 10), query = listFilter.query.toLocaleLowerCase("ko-KR");
    return learningAssignments.filter(a => {
      if (!admin && String(a.empId) !== String(currentUser?.id)) return false;
      const e = empOf(a.empId), course = courseOf(a.courseId);
      if (query && ![e?.name, e?.empNo, e?.dept, course?.name, course?.category].some(v => String(v || "").toLocaleLowerCase("ko-KR").includes(query))) return false;
      const status = listFilter.assignmentStatus;
      if (status === "overdue") return a.status !== "completed" && a.status !== "cancelled" && a.dueDate && a.dueDate < today;
      if (status === "dueSoon") return a.status !== "completed" && a.status !== "cancelled" && a.dueDate && a.dueDate >= today && a.dueDate <= soonDate;
      if (status === "settlementPending") return a.settlementStatus === "pending";
      return status === "all" || a.status === status;
    }).sort((a,b) => String(b.updatedAt || b.assignedAt || "").localeCompare(String(a.updatedAt || a.assignedAt || "")));
  }

  function applyFilters() {
    listFilter.query = String($("#learning-query")?.value || "").trim().slice(0, 100);
    listFilter.courseStatus = $("#learning-course-status")?.value || "all";
    listFilter.assignmentStatus = $("#learning-assignment-status")?.value || "all";
    listFilter.page = 1; render();
  }
  function showDue(kind) { listFilter.assignmentStatus = kind; listFilter.page = 1; render(); }
  function changePage(delta) { listFilter.page += delta; render(); }
  async function exportCsv() {
    const rows = visibleAssignments();
    if (!rows.length) { showToast("추출할 교육 이력이 없습니다.", "info"); return; }
    await root.dlCSV(`교육이력_${new Date().toISOString().slice(0,10)}.csv`,
      ["직원","사번","부서","과정","배정일","이수기한","상태","수료일","점수","수료번호","증빙참조","승인비용","실제정산액","정산상태","정산일"],
      rows.map(a => { const e=empOf(a.empId), c=courseOf(a.courseId); return [e?.name||"",e?.empNo||"",e?.dept||"",c?.name||"",a.assignedAt||"",a.dueDate||"",statusText[a.status]||a.status,a.completedAt||"",a.score??"",a.certificateNo||"",a.evidenceRef||"",a.approvedCost||0,a.settlementStatus==="settled"?(a.settledAmount??a.approvedCost??0):0,a.settlementStatus||"",a.settledAt||""]; }));
  }
  async function exportCombinedCsv() {
    const rows=tools.combinedHistory(learningCourses,learningAssignments,trainingCourses,trainingEnrollments,currentUser?.role==="admin"?null:currentUser?.id);
    if(!rows.length){showToast("추출할 교육 이력이 없습니다.","info");return;}
    await root.dlCSV(`통합교육이력_${new Date().toISOString().slice(0,10)}.csv`,
      ["직원","사번","출처","과정","상태","시작일","종료일","수료일"],
      rows.map(row=>{const employee=empOf(row.empId);return [employee?.name||"",employee?.empNo||"",row.source,row.courseName,row.status,row.startDate,row.endDate,row.completedAt];}));
  }

  function render(){
    const c=$("#content"); if(!c)return;
    const admin=currentUser?.role==="admin", assignments=admin?learningAssignments:learningAssignments.filter(a=>String(a.empId)===String(currentUser?.id));
    const sum=tools.summarize(learningCourses,assignments,admin?null:currentUser?.id), query=listFilter.query.toLocaleLowerCase("ko-KR");
    const courses=learningCourses.filter(x=>(admin||x.status==="active")&&(listFilter.courseStatus==="all"||x.status===listFilter.courseStatus)&&(!query||[x.name,x.category,x.provider].some(v=>String(v||"").toLocaleLowerCase("ko-KR").includes(query))));
    const courseRows=courses.map(x=>{const used=learningAssignments.filter(a=>String(a.courseId)===String(x.id)&&a.status!=="cancelled").length;return`<tr><td><b>${esc(x.name)}</b><div class="fz11 text-gray">${esc(x.category)} · ${esc(x.provider||"자체")}</div></td><td>${esc(x.instructorName||"-")}</td><td>${esc(x.startDate)} ~ ${esc(x.endDate)}<div class="fz11 text-gray">${esc(x.hours)}시간 · ${x.delivery==="online"?"온라인":x.delivery==="blended"?"혼합":"집합"}</div></td><td>${used}/${esc(x.capacity)}</td><td>${statusText[x.status]||esc(x.status)}</td>${admin?`<td><button class="btn btn-ghost btn-sm" onclick="openLearningCourseEditor('${esc(x.id)}')">${x.status==="closed"?"조회":"수정"}</button></td>`:""}</tr>`;}).join("");
    const filtered=visibleAssignments(),pages=Math.max(1,Math.ceil(filtered.length/PAGE_SIZE));listFilter.page=Math.max(1,Math.min(listFilter.page,pages));
    const assignmentRows=filtered.slice((listFilter.page-1)*PAGE_SIZE,listFilter.page*PAGE_SIZE).map(a=>{const course=courseOf(a.courseId),e=empOf(a.empId),settlement={not_required:"정산 없음",pending:"정산 대기",settled:"정산 완료"}[a.settlementStatus||"not_required"];return`<tr><td>${admin?`${esc(e?.name||"삭제된 직원")}<div class="fz11 text-gray">${esc(e?.empNo||"-")} · ${esc(e?.dept||"-")}</div>`:"내 이력"}</td><td>${esc(course?.name||"삭제된 과정")}${a.sourceDocId?`<div class="fz11 text-gray">결재 연계</div>`:""}</td><td>${statusText[a.status]||esc(a.status)}</td><td>${esc(a.dueDate||"-")}</td><td>${esc(a.completedAt||"-")}${a.score!=null?` · ${esc(a.score)}점`:""}${a.evidenceRef?`<div class="fz11 text-gray">증빙 ${esc(a.evidenceRef)}</div>`:""}</td><td>승인 ${money(a.approvedCost)}원<div class="fz11 text-gray">${esc(settlement)}${a.settlementStatus==="settled"?` · 실제 ${money(a.settledAmount??a.approvedCost)}원`:""}${a.settledAt?` · ${esc(a.settledAt)}`:""}</div></td>${admin?`<td><button class="btn btn-ghost btn-sm" onclick="openLearningAssignmentEditor('${esc(a.id)}')">${a.status==="completed"?"정산":"수정"}</button></td>`:""}</tr>`;}).join("");
    const combined=tools.combinedHistory(learningCourses,learningAssignments,trainingCourses,trainingEnrollments,admin?null:currentUser?.id);
    const combinedRows=combined.slice(0,25).map(row=>`<tr><td>${admin?esc(empOf(row.empId)?.name||"삭제된 직원"):"내 이력"}</td><td>${esc(row.source)}</td><td>${esc(row.courseName)}</td><td>${esc(row.status)}</td><td>${esc(row.startDate||"-")} ~ ${esc(row.endDate||"-")}</td><td>${esc(row.completedAt||"-")}</td></tr>`).join("");
    c.innerHTML=`<div class="flex justify-between items-c mb3"><div><h2>🎓 교육 배정·이수·정산</h2><div class="fz12 text-gray">결재 연계 신청과 직원별 배정·수료·정산을 추적합니다. 교육 신청·설문의 직접 신청 과정은 별도 기록입니다.</div></div><div class="flex gap2 wrap">${!admin?`<button class="btn btn-primary" onclick="openApprovalForm('tpl-training')">+ 교육 신청</button>`:""}${admin?`<button class="btn btn-secondary" onclick="openLearningCourseEditor()">+ 과정 등록</button><button class="btn btn-primary" onclick="openLearningAssignmentEditor()">+ 직원 배정</button>`:""}</div></div>
      <div class="kpi-grid mb3"><div class="kpi-card"><div class="kpi-label">운영 과정</div><div class="kpi-val">${sum.activeCourses}</div></div><div class="kpi-card"><div class="kpi-label">배정·수강 중</div><div class="kpi-val">${sum.assigned}</div></div><div class="kpi-card"><div class="kpi-label">이수</div><div class="kpi-val">${sum.completed}</div></div><div class="kpi-card"><div class="kpi-label">7일 내 기한</div><button class="btn btn-ghost btn-sm" onclick="filterLearningDue('dueSoon')">${sum.dueSoon}건 보기</button></div><div class="kpi-card"><div class="kpi-label">기한 경과</div><button class="btn btn-ghost btn-sm text-danger" onclick="filterLearningDue('overdue')">${sum.overdue}건 보기</button></div><div class="kpi-card"><div class="kpi-label">정산 대기</div><button class="btn btn-ghost btn-sm" onclick="filterLearningDue('settlementPending')">${sum.pendingSettlement}건 보기</button><div class="fz11 text-gray">승인 ${money(sum.approvedCost)}원 · 실제 정산 ${money(sum.settledCost)}원</div></div></div>
      <div class="card mb3"><div class="card-body" style="display:flex;gap:10px;align-items:end;flex-wrap:wrap"><div class="fg" style="flex:2;min-width:180px"><label class="fl" for="learning-query">검색</label><input id="learning-query" class="fc" value="${esc(listFilter.query)}" placeholder="과정·직원·사번·부서" onkeydown="if(event.key==='Enter')applyLearningFilters()"></div><div class="fg" style="min-width:120px"><label class="fl" for="learning-course-status">과정 상태</label><select id="learning-course-status" class="fc">${[['all','전체'],['draft','초안'],['active','운영'],['closed','종료']].filter(([v])=>admin||v==='all'||v==='active').map(([v,l])=>`<option value="${v}" ${listFilter.courseStatus===v?'selected':''}>${l}</option>`).join('')}</select></div><div class="fg" style="min-width:130px"><label class="fl" for="learning-assignment-status">배정 상태</label><select id="learning-assignment-status" class="fc">${[['all','전체'],['assigned','배정'],['in_progress','수강 중'],['completed','이수'],['cancelled','취소'],['dueSoon','7일 내 기한'],['overdue','기한 경과'],['settlementPending','정산 대기']].map(([v,l])=>`<option value="${v}" ${listFilter.assignmentStatus===v?'selected':''}>${l}</option>`).join('')}</select></div><button class="btn btn-primary" onclick="applyLearningFilters()">조회</button><button class="btn btn-secondary" onclick="exportLearningCsv()">CSV 추출</button></div></div>
      <div class="card mb3"><div class="card-head"><h3>교육 과정 · ${courses.length}건</h3></div><div class="table-wrap"><table><thead><tr><th>과정</th><th>강사</th><th>일정</th><th>배정/정원</th><th>상태</th>${admin?"<th>관리</th>":""}</tr></thead><tbody>${courseRows||`<tr><td colspan="${admin?6:5}" class="p-empty">조건에 맞는 과정이 없습니다.</td></tr>`}</tbody></table></div></div>
      <div class="card mb3"><div class="card-head"><h3>${admin?"직원별 배정·이수·정산":"나의 배정 교육 이력"} · ${filtered.length}건</h3></div><div class="table-wrap"><table><thead><tr><th>${admin?"직원":"구분"}</th><th>과정</th><th>상태</th><th>이수기한</th><th>수료/점수</th><th>승인비용/정산</th>${admin?"<th>관리</th>":""}</tr></thead><tbody>${assignmentRows||`<tr><td colspan="${admin?7:6}" class="p-empty">조건에 맞는 이력이 없습니다.</td></tr>`}</tbody></table></div><div class="workspace-editor-actions"><button class="btn btn-secondary btn-sm" onclick="changeLearningPage(-1)" ${listFilter.page<=1?'disabled':''}>이전</button><span class="fz12 text-gray">${listFilter.page} / ${pages}</span><button class="btn btn-secondary btn-sm" onclick="changeLearningPage(1)" ${listFilter.page>=pages?'disabled':''}>다음</button></div></div>
      <div class="card"><div class="card-head"><h3>전체 교육 이력 · ${combined.length}건</h3><button class="btn btn-secondary btn-sm" onclick="exportCombinedLearningCsv()">CSV 추출</button></div><div class="card-body"><div class="fz12 text-gray">배정·결재와 직접 신청 기록을 한곳에 읽기 전용으로 표시합니다. 같은 이름의 과정이라도 출처가 다르면 자동 병합·비용 합산하지 않습니다.${combined.length>25?" 최근 25건만 표시합니다.":""}</div></div><div class="table-wrap"><table><thead><tr><th>${admin?"직원":"구분"}</th><th>출처</th><th>과정</th><th>상태</th><th>기간</th><th>수료일</th></tr></thead><tbody>${combinedRows||'<tr><td colspan="6" class="p-empty">교육 이력이 없습니다.</td></tr>'}</tbody></table></div></div>`;
  }
  root.applyLearningFilters=applyFilters;root.filterLearningDue=showDue;root.changeLearningPage=changePage;root.exportLearningCsv=exportCsv;root.exportCombinedLearningCsv=exportCombinedCsv;
  root.renderLearningCenterPage=render;root.renderLearningCourseEditorPage=renderCourseEditor;root.renderLearningAssignmentEditorPage=renderAssignmentEditor;root.openLearningCourseEditor=courseEditor;root.saveLearningCourse=saveCourse;root.openLearningAssignmentEditor=assignmentEditor;root.saveLearningAssignment=saveAssignment;
})(typeof window!=="undefined"?window:null);
