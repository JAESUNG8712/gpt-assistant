(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.employmentRecordTools = api;
})(typeof window !== "undefined" ? window : null, function () {
  "use strict";

  const TYPES = ["contract", "discipline"];
  const STATUSES = ["active", "closed", "expired"];
  const REVIEW_STATUSES = ["open", "completed"];
  const REVIEW_DECISIONS = ["pending", "renew", "end"];
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const text = (v, max) => String(v == null ? "" : v).trim().slice(0, max);
  const validDate = value => { if(!value)return true; const s=String(value); if(!DATE_RE.test(s))return false; const d=new Date(`${s}T00:00:00Z`); return !Number.isNaN(d.getTime())&&d.toISOString().slice(0,10)===s; };

  function validate(input) {
    const errors = [];
    if (!input || !text(input.employeeId, 120)) errors.push("직원을 선택하세요.");
    if (!TYPES.includes(input?.type)) errors.push("기록 유형을 확인하세요.");
    if (!text(input?.title, 120)) errors.push("계약 또는 조치명을 입력하세요.");
    if (!STATUSES.includes(input?.status || "active")) errors.push("상태를 확인하세요.");
    for (const key of ["startDate", "endDate", "decisionDate"]) if (!validDate(input?.[key])) errors.push(`${key} 날짜 형식이 올바르지 않습니다.`);
    if (input?.startDate && input?.endDate && input.endDate < input.startDate) errors.push("종료일은 시작일보다 빠를 수 없습니다.");
    if (input?.type === "contract" && !input.startDate) errors.push("계약 시작일을 입력하세요.");
    if (input?.type === "discipline" && !input.decisionDate) errors.push("징계 결정일을 입력하세요.");
    if (input?.type === "contract") {
      if (!REVIEW_STATUSES.includes(input.reviewStatus || "open")) errors.push("계약 검토 상태를 확인하세요.");
      if (!REVIEW_DECISIONS.includes(input.reviewDecision || "pending")) errors.push("갱신·종료 결정을 확인하세요.");
      if ((input.reviewStatus || "open") === "completed" && (!input.reviewOwnerId || !["renew", "end"].includes(input.reviewDecision))) errors.push("검토 완료 전 담당자와 갱신·종료 결정을 지정하세요.");
    }
    return { ok: errors.length === 0, errors };
  }

  function normalize(input, previous, actor, now) {
    const ts = now || new Date().toISOString();
    return {
      ...(previous || {}), id: text(previous?.id || input?.id, 120), employeeId: text(input?.employeeId, 120),
      type: TYPES.includes(input?.type) ? input.type : "contract", title: text(input?.title, 120),
      status: STATUSES.includes(input?.status) ? input.status : "active", startDate: text(input?.startDate, 10),
      endDate: text(input?.endDate, 10), decisionDate: text(input?.decisionDate, 10), note: text(input?.note, 1000),
      documentRef: text(input?.documentRef, 200), reviewOwnerId: input?.type === "contract" ? text(input?.reviewOwnerId, 120) : "",
      reviewStatus: input?.type === "contract" && REVIEW_STATUSES.includes(input?.reviewStatus) ? input.reviewStatus : "open",
      reviewDecision: input?.type === "contract" && REVIEW_DECISIONS.includes(input?.reviewDecision) ? input.reviewDecision : "pending",
      reviewNote: input?.type === "contract" ? text(input?.reviewNote, 500) : "",
      reviewedAt: input?.type === "contract" && input?.reviewStatus === "completed" ? (previous?.reviewedAt || ts.slice(0, 10)) : "",
      createdAt: previous?.createdAt || ts,
      createdBy: previous?.createdBy || text(actor?.id, 120), updatedAt: ts, updatedBy: text(actor?.id, 120),
    };
  }

  function daysUntil(date, today) {
    if (!validDate(date) || !date) return null;
    const base = new Date(`${today || new Date().toISOString().slice(0, 10)}T00:00:00Z`);
    return Math.ceil((new Date(`${date}T00:00:00Z`) - base) / 86400000);
  }

  function summarize(records, today) {
    const rows = Array.isArray(records) ? records : [];
    const contract = rows.filter(r => r?.type === "contract" && r.status === "active");
    return {
      total: rows.length,
      activeContracts: contract.length,
      due30: contract.filter(r => { const d = daysUntil(r.endDate, today); return d != null && d >= 0 && d <= 30; }).length,
      overdue: contract.filter(r => { const d = daysUntil(r.endDate, today); return d != null && d < 0; }).length,
      activeDiscipline: rows.filter(r => r?.type === "discipline" && r.status === "active").length,
    };
  }

  return { TYPES, STATUSES, REVIEW_STATUSES, REVIEW_DECISIONS, validate, normalize, daysUntil, summarize };
});

(function attachUi(root) {
  if (!root || !root.document) return;
  const tools = root.employmentRecordTools;
  const esc = value => typeof root.h === "function" ? root.h(String(value == null ? "" : value)) : String(value == null ? "" : value);
  const emp = id => (employees || []).find(e => String(e.id) === String(id));
  const statusLabel = { active: "진행", closed: "종결", expired: "만료" };
  const reviewStatusLabel = { open: "검토 중", completed: "처리 완료" };
  const reviewDecisionLabel = { pending: "미결정", renew: "갱신", end: "종료" };
  let editingId = null;
  const listFilter = { query: "", review: "all", page: 1 };
  const PAGE_SIZE = 25;

  function openEditor(id) {
    if (!currentUser || currentUser.role !== "admin") return root._pageAccessDenied();
    editingId = id == null ? null : String(id);
    root.gotoPage("employment-records-edit");
  }

  function toggleReviewFields() {
    const block = root.document.getElementById("er-review-block"); if (!block) return;
    const contract = root.document.getElementById("er-type")?.value === "contract";
    block.disabled = !contract; block.style.display = contract ? "" : "none";
  }

  function renderEditor() {
    if (!currentUser || currentUser.role !== "admin") return root._pageAccessDenied();
    const old = editingId == null ? null : (employmentRecords || []).find(r => String(r.id) === editingId);
    if (editingId != null && !old) { root.gotoPage("employment-records"); root.showToast("기록을 찾을 수 없습니다.", "error"); return; }
    const record = old || { type: "contract", status: "active", employeeId: "", title: "", startDate: "", endDate: "", decisionDate: "", note: "", documentRef: "", reviewOwnerId: "", reviewStatus: "open", reviewDecision: "pending", reviewNote: "" };
    const options = (employees || []).filter(e => e.active !== false || String(e.id) === String(record.employeeId)).map(e => `<option value="${esc(e.id)}" ${String(e.id) === String(record.employeeId) ? "selected" : ""}>${esc(e.name)} (${esc(e.empNo || "-")}) · ${esc(e.dept || "-")}</option>`).join("");
    const owners = (employees || []).filter(e => e.role === "admin" && ((e.active !== false && e.menuPerms?.["employment-records"] !== false) || String(e.id) === String(record.reviewOwnerId))).map(e => `<option value="${esc(e.id)}" ${String(e.id) === String(record.reviewOwnerId) ? "selected" : ""}>${esc(e.name)} (${esc(e.empNo || "-")})</option>`).join("");
    const reviewEvents = Array.isArray(record.reviewEvents) ? record.reviewEvents : [];
    const body = `
      <div class="info-note mb3">근로계약은 시작·종료일을, 징계는 결정일과 조치명을 기록하세요. 주민번호·상세 조사자료 등 불필요한 민감정보는 메모에 입력하지 마세요.</div>
      <div class="form-grid"><div class="fg"><label class="fl">직원 *</label><select id="er-employee"><option value="">선택</option>${options}</select></div>
      <div class="fg"><label class="fl">유형 *</label><select id="er-type" onchange="toggleEmploymentReviewFields()"><option value="contract" ${record.type === "contract" ? "selected" : ""}>근로계약</option><option value="discipline" ${record.type === "discipline" ? "selected" : ""}>징계</option></select></div>
      <div class="fg"><label class="fl">계약/조치명 *</label><input id="er-title" maxlength="120" value="${esc(record.title)}" placeholder="예: 기간제 근로계약 / 견책"></div>
      <div class="fg"><label class="fl">상태 *</label><select id="er-status">${Object.entries(statusLabel).map(([v,l]) => `<option value="${v}" ${record.status === v ? "selected" : ""}>${l}</option>`).join("")}</select></div>
      <div class="fg"><label class="fl">시작일</label><input id="er-start" type="date" value="${esc(record.startDate)}"></div><div class="fg"><label class="fl">종료일</label><input id="er-end" type="date" value="${esc(record.endDate)}"></div>
      <div class="fg"><label class="fl">결정일</label><input id="er-decision" type="date" value="${esc(record.decisionDate)}"></div><div class="fg"><label class="fl">문서 참조</label><input id="er-document" maxlength="200" value="${esc(record.documentRef)}" placeholder="예: 전자결재 HR-2026-001"></div></div>
      <fieldset id="er-review-block" style="border:0;padding:0;margin:0;${record.type === "contract" ? "" : "display:none"}" ${record.type === "contract" ? "" : "disabled"}><h3 class="mb2">계약 만료 검토</h3><div class="info-note mb3">담당자가 갱신 또는 종료를 결정한 뒤 처리 완료로 표시하세요. 계약 상태 변경은 별도로 확인해야 합니다.</div><div class="form-grid"><div class="fg"><label class="fl" for="er-review-owner">검토 담당자</label><select id="er-review-owner"><option value="">담당자 선택</option>${owners}</select></div><div class="fg"><label class="fl" for="er-review-status">검토 상태</label><select id="er-review-status"><option value="open" ${(record.reviewStatus || "open") === "open" ? "selected" : ""}>검토 중</option><option value="completed" ${record.reviewStatus === "completed" ? "selected" : ""}>처리 완료</option></select></div><div class="fg"><label class="fl" for="er-review-decision">처리 결정</label><select id="er-review-decision"><option value="pending" ${(record.reviewDecision || "pending") === "pending" ? "selected" : ""}>미결정</option><option value="renew" ${record.reviewDecision === "renew" ? "selected" : ""}>갱신</option><option value="end" ${record.reviewDecision === "end" ? "selected" : ""}>종료</option></select></div><div class="fg"><label class="fl">처리일</label><input value="${esc(record.reviewedAt || "미완료")}" readonly></div></div><div class="fg"><label class="fl" for="er-review-note">검토 의견</label><textarea id="er-review-note" rows="2" maxlength="500" placeholder="예: 갱신 조건 확인 후 새 계약서 상신">${esc(record.reviewNote)}</textarea></div>${reviewEvents.length ? `<div class="fz12 text-gray">검토 변경 이력 ${reviewEvents.length}건 · 최근 ${esc(reviewEvents.at(-1)?.at?.slice(0, 16).replace("T", " ") || "-")}</div>` : ""}</fieldset>
      <div class="fg"><label class="fl">관리 메모</label><textarea id="er-note" rows="4" maxlength="1000" placeholder="예: 계약 관련 참고사항(민감정보 제외)">${esc(record.note)}</textarea></div><div id="er-errors" class="alert alert-error" role="alert" style="display:none"></div>`;
    root.renderWorkspaceFormPage({ title: old ? "계약·징계 기록 수정" : "계약·징계 기록 등록", description: "직원별 계약과 인사 조치를 등록하고 기한을 관리합니다.", backPage: "employment-records", body, saveAction: "saveEmploymentRecord()" });
    if (reviewEvents.length && record.type === "contract") {
      const details = root.document.createElement("details");
      details.className = "mb3";
      const summary = root.document.createElement("summary");
      summary.textContent = `검토 변경 이력 ${reviewEvents.length}건 보기`;
      details.append(summary);
      const list = root.document.createElement("ol");
      for (const event of reviewEvents.slice().reverse()) {
        const item = root.document.createElement("li");
        const actor = emp(event.actorId), owner = emp(event.ownerId);
        item.textContent = `${String(event.at || "").slice(0, 16).replace("T", " ")} · ${actor?.name || "기록자 미확인"} · 담당 ${owner?.name || "미지정"} · ${reviewStatusLabel[event.status] || "검토 중"} / ${reviewDecisionLabel[event.decision] || "미결정"}`;
        list.append(item);
      }
      details.append(list);
      root.document.getElementById("er-review-block")?.append(details);
    }
  }

  async function save(id) {
    const targetId = id == null ? editingId : String(id);
    const old = targetId == null ? null : (employmentRecords || []).find(r => String(r.id) === targetId);
    if (targetId != null && !old) { root.showToast("기록을 다시 확인하세요.", "error"); return; }
    const input = { employeeId: $("#er-employee")?.value, type: $("#er-type")?.value, title: $("#er-title")?.value,
      status: $("#er-status")?.value, startDate: $("#er-start")?.value, endDate: $("#er-end")?.value,
      decisionDate: $("#er-decision")?.value, documentRef: $("#er-document")?.value, note: $("#er-note")?.value,
      reviewOwnerId: $("#er-review-owner")?.value, reviewStatus: $("#er-review-status")?.value,
      reviewDecision: $("#er-review-decision")?.value, reviewNote: $("#er-review-note")?.value };
    const check = tools.validate(input), box = $("#er-errors");
    if (!check.ok) { if (box) { box.style.display = "block"; box.innerHTML = check.errors.map(esc).join("<br>"); } return; }
    const person = emp(input.employeeId);
    const ok = await root.askConfirmModal({ title: old ? "기록 수정" : "기록 등록", message: `${person?.name || "선택한 직원"}의 ${input.type === "contract" ? "근로계약" : "징계"} 기록을 저장합니다.`, confirmText: "저장", impacts: [{ label: "직원", value: `${person?.name || "-"} (${person?.empNo || "-"})` }, { label: "기록", value: input.title }, { label: "상태", value: statusLabel[input.status] }, ...(input.type === "contract" ? [{ label: "만료 검토", value: `${reviewStatusLabel[input.reviewStatus]} · ${reviewDecisionLabel[input.reviewDecision]}` }] : [])] });
    if (!ok) return;
    const next = tools.normalize({ ...input, id: old?.id || genId() }, old, currentUser);
    if (old) employmentRecords = employmentRecords.map(r => String(r.id) === String(old.id) ? next : r); else employmentRecords.push(next);
    root.queueTrackedSave("계약·징계 기록"); root.gotoPage("employment-records");
  }

  async function remove(id) {
    const record = (employmentRecords || []).find(r => String(r.id) === String(id)); if (!record) return;
    const person = emp(record.employeeId);
    const ok = await root.askConfirmModal({ title: "기록 삭제", message: "이 감사 원장 기록을 삭제하시겠습니까?", confirmText: "삭제", danger: true,
      impacts: [{ label: "직원", value: person?.name || "-" }, { label: "기록", value: record.title }], warnings: ["삭제 후에는 일반 화면에서 복구할 수 없습니다. 필요하면 먼저 데이터 백업을 받으세요."] });
    if (!ok) return; root._tombstone("employmentRecords", record.id); employmentRecords = employmentRecords.filter(r => String(r.id) !== String(id)); root.queueTrackedSave("계약·징계 기록 삭제"); render();
  }

  function applyFilters() {
    listFilter.query = String(root.document.getElementById("er-list-query")?.value || "").trim().slice(0, 100);
    listFilter.review = root.document.getElementById("er-list-review")?.value || "all";
    listFilter.page = 1; render();
  }
  function showReview(kind) { listFilter.review = kind; listFilter.page = 1; render(); }
  function changePage(delta) { listFilter.page += delta; render(); }
  function filteredRows(rows) {
    const q = listFilter.query.toLocaleLowerCase("ko-KR");
    return rows.filter(r => {
      const e = emp(r.employeeId), owner = emp(r.reviewOwnerId), due = r.type === "contract" && r.status === "active" ? tools.daysUntil(r.endDate) : null;
      if (q && ![e?.name, e?.empNo, e?.dept, r.title, owner?.name].some(v => String(v || "").toLocaleLowerCase("ko-KR").includes(q))) return false;
      if (listFilter.review === "unassigned") return r.type === "contract" && r.status === "active" && r.reviewStatus !== "completed" && !r.reviewOwnerId;
      if (listFilter.review === "due30") return due != null && due >= 0 && due <= 30 && r.reviewStatus !== "completed";
      if (listFilter.review === "overdue") return due != null && due < 0 && r.reviewStatus !== "completed";
      if (listFilter.review === "completed") return r.type === "contract" && r.reviewStatus === "completed";
      if (listFilter.review === "open") return r.type === "contract" && r.reviewStatus !== "completed";
      return true;
    }).sort((a,b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  }

  function render() {
    const c = root.document.getElementById("content"); if (!c) return;
    if (!currentUser || currentUser.role !== "admin") return root._pageAccessDenied();
    const rows = Array.isArray(employmentRecords) ? employmentRecords : [], sum = tools.summarize(rows);
    const unresolved=rows.filter(r=>r.type==="contract"&&r.status==="active"&&r.reviewStatus!=="completed");
    const unassigned=unresolved.filter(r=>!r.reviewOwnerId).length;
    const dueOpen=unresolved.filter(r=>{const d=tools.daysUntil(r.endDate);return d!=null&&d>=0&&d<=30;}).length;
    const overdueOpen=unresolved.filter(r=>{const d=tools.daysUntil(r.endDate);return d!=null&&d<0;}).length;
    const visible=filteredRows(rows),pages=Math.max(1,Math.ceil(visible.length/PAGE_SIZE));listFilter.page=Math.max(1,Math.min(listFilter.page,pages));
    const body = visible.slice((listFilter.page-1)*PAGE_SIZE,listFilter.page*PAGE_SIZE).map(r => { const e = emp(r.employeeId), owner = emp(r.reviewOwnerId), due = r.type === "contract" ? tools.daysUntil(r.endDate) : null; return `<tr><td>${esc(e?.name || "삭제된 직원")}<div class="fz11 text-gray">${esc(e?.empNo || "-")} · ${esc(e?.dept || "-")}</div></td><td>${r.type === "contract" ? "근로계약" : "징계"}</td><td>${esc(r.title)}</td><td>${esc(r.type === "contract" ? `${r.startDate || "-"} ~ ${r.endDate || "-"}` : r.decisionDate || "-")}${due != null && due <= 30 ? `<div class="fz11 ${due < 0 ? "text-danger" : "text-warn"}">${due < 0 ? `${-due}일 경과` : `${due}일 남음`}</div>` : ""}</td><td><span class="badge">${statusLabel[r.status] || esc(r.status)}</span>${r.type === "contract" ? `<div class="fz11 text-gray">${reviewStatusLabel[r.reviewStatus || "open"]} · ${reviewDecisionLabel[r.reviewDecision || "pending"]}<br>담당 ${esc(owner?.name || "미지정")}${r.reviewedAt ? ` · ${esc(r.reviewedAt)}` : ""}</div>` : ""}</td><td><button class="btn btn-ghost btn-sm" onclick="openEmploymentRecordEditor('${esc(r.id)}')">${r.type === "contract" ? "검토·수정" : "수정"}</button><button class="btn btn-ghost btn-sm text-danger" onclick="deleteEmploymentRecord('${esc(r.id)}')">삭제</button></td></tr>`; }).join("");
    c.innerHTML = `<div class="flex justify-between items-c mb3"><div><h2>🗃 계약·징계 원장</h2><div class="fz12 text-gray">관리자 전용 · 계약 만료와 인사 조치 이력을 안전하게 관리합니다.</div></div><button class="btn btn-primary" onclick="openEmploymentRecordEditor()">+ 기록 등록</button></div>
      <div class="kpi-grid mb3"><div class="kpi-card"><div class="kpi-label">전체 기록</div><div class="kpi-val">${sum.total}</div></div><div class="kpi-card"><div class="kpi-label">진행 계약</div><div class="kpi-val">${sum.activeContracts}</div></div><div class="kpi-card"><div class="kpi-label">담당 미지정</div><button class="btn btn-ghost btn-sm" onclick="filterEmploymentReview('unassigned')">${unassigned}건 보기</button></div><div class="kpi-card"><div class="kpi-label">30일 내 검토</div><button class="btn btn-ghost btn-sm" onclick="filterEmploymentReview('due30')">${dueOpen}건 보기</button></div><div class="kpi-card"><div class="kpi-label">기한 경과 검토</div><button class="btn btn-ghost btn-sm text-danger" onclick="filterEmploymentReview('overdue')">${overdueOpen}건 보기</button></div></div>
      ${unassigned || dueOpen || overdueOpen ? `<div class="warn-note mb3">계약 검토 알림: 담당 미지정 ${unassigned}건 · 30일 내 만료 미처리 ${dueOpen}건 · 기한 경과 미처리 ${overdueOpen}건. 검토 후 갱신·종료 결정을 기록하세요.</div>` : ""}
      <div class="card mb3"><div class="card-body" style="display:flex;gap:10px;align-items:end;flex-wrap:wrap"><div class="fg" style="flex:2;min-width:180px"><label class="fl" for="er-list-query">검색</label><input class="fc" id="er-list-query" value="${esc(listFilter.query)}" placeholder="직원·사번·계약명·담당자" onkeydown="if(event.key==='Enter')applyEmploymentFilters()"></div><div class="fg" style="min-width:140px"><label class="fl" for="er-list-review">검토 상태</label><select class="fc" id="er-list-review">${[['all','전체'],['unassigned','담당 미지정'],['due30','30일 내 만료'],['overdue','기한 경과'],['open','검토 중'],['completed','처리 완료']].map(([v,l])=>`<option value="${v}" ${listFilter.review===v?'selected':''}>${l}</option>`).join('')}</select></div><button class="btn btn-primary" onclick="applyEmploymentFilters()">조회</button></div></div>
      <div class="card"><div class="card-head"><h3>계약·징계 기록 · ${visible.length}건</h3></div><div class="table-wrap"><table><thead><tr><th>직원</th><th>유형</th><th>계약/조치명</th><th>기준일</th><th>상태·검토</th><th>관리</th></tr></thead><tbody>${body || `<tr><td colspan="6" class="text-gray" style="text-align:center;padding:28px">조건에 맞는 기록이 없습니다.</td></tr>`}</tbody></table></div><div class="workspace-editor-actions"><button class="btn btn-secondary btn-sm" onclick="changeEmploymentPage(-1)" ${listFilter.page<=1?'disabled':''}>이전</button><span class="fz12 text-gray">${listFilter.page} / ${pages}</span><button class="btn btn-secondary btn-sm" onclick="changeEmploymentPage(1)" ${listFilter.page>=pages?'disabled':''}>다음</button></div></div>`;
  }
  root.renderEmploymentRecordsPage = render; root.renderEmploymentRecordEditorPage = renderEditor; root.openEmploymentRecordEditor = openEditor; root.toggleEmploymentReviewFields = toggleReviewFields; root.saveEmploymentRecord = save; root.deleteEmploymentRecord = remove; root.applyEmploymentFilters = applyFilters; root.filterEmploymentReview = showReview; root.changeEmploymentPage = changePage;
})(typeof window !== "undefined" ? window : null);
