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
    return { ok: errors.length === 0, errors };
  }

  function validateSettlement(a) {
    const errors = [];
    if (!["not_required", "pending", "settled"].includes(a?.settlementStatus)) errors.push("비용 정산 상태를 확인하세요.");
    if (a?.settledAt && !validDate(a.settledAt)) errors.push("정산일을 확인하세요.");
    return { ok: errors.length === 0, errors };
  }

  function summarize(courses, assignments, empId) {
    const cs = Array.isArray(courses) ? courses : [], all = Array.isArray(assignments) ? assignments : [];
    const rows = empId == null ? all : all.filter(a => String(a.empId) === String(empId));
    return { activeCourses: cs.filter(c => c.status === "active").length, assigned: rows.filter(a => a.status === "assigned" || a.status === "in_progress").length,
      completed: rows.filter(a => a.status === "completed").length, overdue: rows.filter(a => a.status !== "completed" && a.status !== "cancelled" && a.dueDate && a.dueDate < new Date().toISOString().slice(0, 10)).length,
      pendingSettlement: rows.filter(a => a.settlementStatus === "pending").length,
      approvedCost: rows.reduce((sum, a) => sum + (Number(a.approvedCost) || 0), 0),
      settledCost: rows.filter(a => a.settlementStatus === "settled").reduce((sum, a) => sum + (Number(a.approvedCost) || 0), 0) };
  }
  return { validateCourse, validateAssignment, validateSettlement, summarize };
});

(function attachUi(root) {
  if (!root || !root.document) return;
  const tools = root.learningCenterTools, esc = value => h(String(value == null ? "" : value));
  const courseOf = id => learningCourses.find(c => String(c.id) === String(id));
  const empOf = id => employees.find(e => String(e.id) === String(id));
  const statusText = { draft: "초안", active: "운영", closed: "종료", assigned: "배정", in_progress: "수강 중", completed: "이수", cancelled: "취소" };
  let editingCourseId = null, editingAssignmentId = null;

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
    autoSaveToServerIfEnabled();showToast("교육 과정을 저장했습니다.","success");root.gotoPage("learning-center");
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
    const a=old||{courseId:"",empId:"",status:"assigned",assignedAt:new Date().toISOString().slice(0,10),dueDate:"",score:"",certificateNo:"",note:"",approvedCost:0,costCenter:"",settlementStatus:"not_required",settledAt:"",settlementNote:""};
    const approved=a.source==="approval", completed=a.status==="completed", lockCore=approved||completed;
    const courses=learningCourses.filter(c=>c.status!=="closed"||String(c.id)===String(a.courseId)).map(c=>`<option value="${esc(c.id)}" ${String(c.id)===String(a.courseId)?"selected":""}>${esc(c.name)} · ${esc(c.startDate)}~${esc(c.endDate)}</option>`).join("");
    const emps=employees.filter(e=>e.active!==false||String(e.id)===String(a.empId)).map(e=>`<option value="${esc(e.id)}" ${String(e.id)===String(a.empId)?"selected":""}>${esc(e.name)} (${esc(e.empNo||"-")}) · ${esc(e.dept||"-")}</option>`).join("");
    const body=`${approved?'<div class="info-note mb3">결재로 확정된 과정·직원·기간·승인비용은 변경할 수 없습니다. 수강 상태와 수료 증빙, 정산만 처리하세요.</div>':""}${completed?'<div class="info-note mb3">수료 이력이 확정되었습니다. 이후에는 정산 항목만 수정할 수 있습니다.</div>':""}
      <div class="form-grid"><div class="fg"><label class="fl">과정 *</label><select id="la-course" ${lockCore?"disabled":""}><option value="">선택</option>${courses}</select></div><div class="fg"><label class="fl">직원 *</label><select id="la-emp" ${old?"disabled":""}><option value="">선택</option>${emps}</select></div>
      <div class="fg"><label class="fl">배정일 *</label><input id="la-assigned" type="date" value="${esc(a.assignedAt)}" ${lockCore?"disabled":""}></div><div class="fg"><label class="fl">이수기한</label><input id="la-due" type="date" value="${esc(a.dueDate)}" ${lockCore?"disabled":""}></div>
      <div class="fg"><label class="fl">상태</label><select id="la-status" ${completed?"disabled":""}>${["assigned","in_progress","completed","cancelled"].map(v=>`<option value="${v}" ${a.status===v?"selected":""}>${statusText[v]}</option>`).join("")}</select></div><div class="fg"><label class="fl">점수</label><input id="la-score" type="number" min="0" max="100" value="${esc(a.score??"")}" placeholder="예: 85" ${completed?"disabled":""}></div>
      <div class="fg"><label class="fl">수료번호</label><input id="la-cert" maxlength="120" value="${esc(a.certificateNo)}" placeholder="예: CERT-2026-001" ${completed?"disabled":""}></div><div class="fg"><label class="fl">승인 비용(원)</label><input id="la-cost" type="number" min="0" max="1000000000" value="${esc(a.approvedCost||0)}" placeholder="예: 350000" ${lockCore?"disabled":""}></div>
      <div class="fg"><label class="fl">비용 귀속</label><input id="la-cost-center" maxlength="100" value="${esc(a.costCenter)}" placeholder="예: 경영지원팀" ${lockCore?"disabled":""}></div><div class="fg"><label class="fl">정산 상태</label><select id="la-settlement"><option value="not_required" ${a.settlementStatus==="not_required"?"selected":""}>정산 없음</option><option value="pending" ${a.settlementStatus==="pending"?"selected":""}>정산 대기</option><option value="settled" ${a.settlementStatus==="settled"?"selected":""}>정산 완료</option></select></div>
      <div class="fg"><label class="fl">정산일</label><input id="la-settled-at" type="date" value="${esc(a.settledAt)}"></div></div><div class="fg"><label class="fl">메모</label><textarea id="la-note" maxlength="500" rows="2" ${completed?"disabled":""}>${esc(a.note)}</textarea></div><div class="fg"><label class="fl">정산 메모</label><textarea id="la-settlement-note" maxlength="500" rows="2" placeholder="예: 법인카드 전표 2026-001 확인">${esc(a.settlementNote)}</textarea></div><div id="la-errors" class="alert alert-error" role="alert" style="display:none"></div>`;
    root.renderWorkspaceFormPage({title:old?"교육 배정·정산 수정":"직원 교육 배정",description:"배정 후 수료를 확정하면 직원 교육이력에 반영됩니다.",backPage:"learning-center",body,saveAction:"saveLearningAssignment()"});
  }

  async function saveAssignment(id) {
    const targetId=id == null ? editingAssignmentId : String(id);
    const old=targetId == null ? null : learningAssignments.find(a=>String(a.id)===targetId);
    if(targetId != null && !old){showToast("교육 배정을 다시 확인하세요.","error");return;}
    const input={id:old?.id||genId(),courseId:$("#la-course")?.value,empId:old?.empId||$("#la-emp")?.value,status:$("#la-status")?.value,assignedAt:$("#la-assigned")?.value,dueDate:$("#la-due")?.value,score:$("#la-score")?.value,certificateNo:$("#la-cert")?.value,note:$("#la-note")?.value,approvedCost:Number($("#la-cost")?.value||0),costCenter:$("#la-cost-center")?.value,settlementStatus:$("#la-settlement")?.value,settledAt:$("#la-settled-at")?.value,settlementNote:$("#la-settlement-note")?.value};
    if(old?.source==="approval")Object.assign(input,{courseId:old.courseId,empId:old.empId,assignedAt:old.assignedAt,dueDate:old.dueDate,approvedCost:old.approvedCost,costCenter:old.costCenter});
    if(old?.status==="completed")Object.assign(input,{courseId:old.courseId,empId:old.empId,status:old.status,assignedAt:old.assignedAt,dueDate:old.dueDate,score:old.score,certificateNo:old.certificateNo,note:old.note,approvedCost:old.approvedCost,costCenter:old.costCenter});
    const box=$("#la-errors"),check=old?.status==="completed"?tools.validateSettlement(input):tools.validateAssignment(input,learningCourses,learningAssignments,old?.id);
    if(!check.ok){box.style.display="block";box.innerHTML=check.errors.map(esc).join("<br>");return;}
    const c=courseOf(input.courseId),e=empOf(input.empId),ok=await askConfirmModal({title:old?.status==="completed"?"교육비 정산 수정":old?"교육 배정 수정":"교육 배정",message:`${e?.name||"선택 직원"}의 ‘${c?.name||"과정"}’ 내용을 저장합니다.`,confirmText:"저장",impacts:[{label:"직원",value:e?.name||"-"},{label:"과정",value:c?.name||"-"},{label:"상태",value:statusText[input.status]},{label:"정산",value:{not_required:"없음",pending:"대기",settled:"완료"}[input.settlementStatus]}]});if(!ok)return;
    const now=new Date().toISOString(),settledAt=input.settlementStatus==="settled"?(input.settledAt||now.slice(0,10)):"";
    const next=old?.status==="completed"?{...old,settlementStatus:input.settlementStatus,settledAt,settlementNote:input.settlementNote,updatedAt:now,updatedBy:currentUser.id}:{...old,...input,score:input.score===""?null:Number(input.score),completedAt:input.status==="completed"?(old?.completedAt||now.slice(0,10)):"",settledAt,createdAt:old?.createdAt||now,createdBy:old?.createdBy||currentUser.id,updatedAt:now,updatedBy:currentUser.id};
    if(old)learningAssignments=learningAssignments.map(a=>String(a.id)===String(old.id)?next:a);else learningAssignments.push(next);
    if(next.status==="completed"&&old?.status!=="completed"&&e){const historyId=`learning-${next.id}`,hist={id:historyId,type:"edu_general",desc:c?.name||"교육 이수",name:c?.name||"",institution:c?.provider||"",date:next.completedAt,startDate:c?.startDate||"",endDate:c?.endDate||"",note:`${c?.hours||0}시간${next.certificateNo?` · 수료번호 ${next.certificateNo}`:""}`,createdAt:now};e.hrHistory=[...(e.hrHistory||[]).filter(h=>String(h.id)!==historyId),hist];e.updatedAt=now;}
    autoSaveToServerIfEnabled();showToast(old?.status==="completed"?"교육비 정산을 저장했습니다.":"교육 배정·이력을 저장했습니다.","success");root.gotoPage("learning-center");
  }

  function render(){const c=$("#content");if(!c)return;const admin=currentUser?.role==="admin",assignments=admin?learningAssignments:learningAssignments.filter(a=>String(a.empId)===String(currentUser?.id)),sum=tools.summarize(learningCourses,assignments,admin?null:currentUser?.id);
    const courseRows=learningCourses.filter(x=>admin||x.status==="active").map(x=>{const used=learningAssignments.filter(a=>String(a.courseId)===String(x.id)&&a.status!=="cancelled").length;return`<tr><td><b>${esc(x.name)}</b><div class="fz11 text-gray">${esc(x.category)} · ${esc(x.provider||"자체")}</div></td><td>${esc(x.instructorName||"-")}</td><td>${esc(x.startDate)} ~ ${esc(x.endDate)}<div class="fz11 text-gray">${esc(x.hours)}시간 · ${x.delivery==="online"?"온라인":x.delivery==="blended"?"혼합":"집합"}</div></td><td>${used}/${esc(x.capacity)}</td><td>${statusText[x.status]||esc(x.status)}</td>${admin?`<td><button class="btn btn-ghost btn-sm" onclick="openLearningCourseEditor('${esc(x.id)}')">수정</button></td>`:""}</tr>`;}).join("");
    const assignmentRows=assignments.map(a=>{const course=courseOf(a.courseId),e=empOf(a.empId),settlement={not_required:"정산 없음",pending:"정산 대기",settled:"정산 완료"}[a.settlementStatus||"not_required"];return`<tr><td>${admin?`${esc(e?.name||"삭제된 직원")}<div class="fz11 text-gray">${esc(e?.empNo||"-")}</div>`:"내 이력"}</td><td>${esc(course?.name||"삭제된 과정")}${a.sourceDocId?`<div class="fz11 text-gray">결재 연계</div>`:""}</td><td>${statusText[a.status]||esc(a.status)}</td><td>${esc(a.dueDate||"-")}</td><td>${esc(a.completedAt||"-")}${a.score!=null?` · ${esc(a.score)}점`:""}</td><td>${Number(a.approvedCost||0).toLocaleString()}원<div class="fz11 text-gray">${esc(settlement)}${a.settledAt?` · ${esc(a.settledAt)}`:""}</div></td>${admin?`<td><button class="btn btn-ghost btn-sm" onclick="openLearningAssignmentEditor('${esc(a.id)}')">수정</button></td>`:""}</tr>`;}).join("");
    c.innerHTML=`<div class="flex justify-between items-c mb3"><div><h2>🎓 교육 과정·이력</h2><div class="fz12 text-gray">교육 신청·결재·배정·수료·비용 정산을 한 흐름으로 연결합니다.</div></div><div class="flex gap2">${!admin?`<button class="btn btn-primary" onclick="openApprovalForm('tpl-training')">+ 교육 신청</button>`:""}${admin?`<button class="btn btn-secondary" onclick="openLearningCourseEditor()">+ 과정 등록</button><button class="btn btn-primary" onclick="openLearningAssignmentEditor()">+ 직원 배정</button>`:""}</div></div><div class="kpi-grid mb3"><div class="kpi-card"><div class="kpi-label">운영 과정</div><div class="kpi-val">${sum.activeCourses}</div></div><div class="kpi-card"><div class="kpi-label">수강 중·배정</div><div class="kpi-val">${sum.assigned}</div></div><div class="kpi-card"><div class="kpi-label">이수</div><div class="kpi-val">${sum.completed}</div></div><div class="kpi-card"><div class="kpi-label">정산 대기</div><div class="kpi-val" style="color:${sum.pendingSettlement?"#b45309":"inherit"}">${sum.pendingSettlement}</div><div class="fz11 text-gray">승인 ${sum.approvedCost.toLocaleString()}원 · 정산 ${sum.settledCost.toLocaleString()}원</div></div><div class="kpi-card"><div class="kpi-label">기한 경과</div><div class="kpi-val" style="color:#b91c1c">${sum.overdue}</div></div></div><div class="card mb3"><div class="card-head"><h3>교육 과정</h3></div><div class="table-wrap"><table><thead><tr><th>과정</th><th>강사</th><th>일정</th><th>배정/정원</th><th>상태</th>${admin?"<th>관리</th>":""}</tr></thead><tbody>${courseRows||`<tr><td colspan="${admin?6:5}" class="p-empty">등록된 과정이 없습니다.</td></tr>`}</tbody></table></div></div><div class="card"><div class="card-head"><h3>${admin?"직원별 배정·이수·정산":"나의 교육 이력"}</h3></div><div class="table-wrap"><table><thead><tr><th>${admin?"직원":"구분"}</th><th>과정</th><th>상태</th><th>이수기한</th><th>수료/점수</th><th>승인비용/정산</th>${admin?"<th>관리</th>":""}</tr></thead><tbody>${assignmentRows||`<tr><td colspan="${admin?7:6}" class="p-empty">교육 이력이 없습니다.</td></tr>`}</tbody></table></div></div>`;}
  root.renderLearningCenterPage=render;root.renderLearningCourseEditorPage=renderCourseEditor;root.renderLearningAssignmentEditorPage=renderAssignmentEditor;root.openLearningCourseEditor=courseEditor;root.saveLearningCourse=saveCourse;root.openLearningAssignmentEditor=assignmentEditor;root.saveLearningAssignment=saveAssignment;
})(typeof window!=="undefined"?window:null);
