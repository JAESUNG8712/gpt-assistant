(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.employmentRecordTools = api;
})(typeof window !== "undefined" ? window : null, function () {
  "use strict";

  const TYPES = ["contract", "discipline"];
  const STATUSES = ["active", "closed", "expired"];
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const text = (v, max) => String(v == null ? "" : v).trim().slice(0, max);
  const validDate = value => !value || (DATE_RE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)));

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
    return { ok: errors.length === 0, errors };
  }

  function normalize(input, previous, actor, now) {
    const ts = now || new Date().toISOString();
    return {
      ...(previous || {}), id: text(previous?.id || input?.id, 120), employeeId: text(input?.employeeId, 120),
      type: TYPES.includes(input?.type) ? input.type : "contract", title: text(input?.title, 120),
      status: STATUSES.includes(input?.status) ? input.status : "active", startDate: text(input?.startDate, 10),
      endDate: text(input?.endDate, 10), decisionDate: text(input?.decisionDate, 10), note: text(input?.note, 1000),
      documentRef: text(input?.documentRef, 200), createdAt: previous?.createdAt || ts,
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

  return { TYPES, STATUSES, validate, normalize, daysUntil, summarize };
});

(function attachUi(root) {
  if (!root || !root.document) return;
  const tools = root.employmentRecordTools;
  const esc = value => typeof root.h === "function" ? root.h(String(value == null ? "" : value)) : String(value == null ? "" : value);
  const emp = id => (employees || []).find(e => String(e.id) === String(id));
  const statusLabel = { active: "진행", closed: "종결", expired: "만료" };

  function openEditor(id) {
    if (!currentUser || currentUser.role !== "admin") return root._pageAccessDenied();
    const old = (employmentRecords || []).find(r => String(r.id) === String(id));
    const record = old || { type: "contract", status: "active", employeeId: "", title: "", startDate: "", endDate: "", decisionDate: "", note: "", documentRef: "" };
    const options = (employees || []).filter(e => e.active !== false).map(e => `<option value="${esc(e.id)}" ${String(e.id) === String(record.employeeId) ? "selected" : ""}>${esc(e.name)} (${esc(e.empNo || "-")}) · ${esc(e.dept || "-")}</option>`).join("");
    root.showModal(`<div class="modal modal-lg"><div class="modal-head"><h2>${old ? "계약·징계 기록 수정" : "계약·징계 기록 등록"}</h2><button class="modal-close" onclick="closeModal()">×</button></div><div class="modal-body">
      <div class="info-note mb3">근로계약은 시작·종료일을, 징계는 결정일과 조치명을 기록하세요. 주민번호·상세 조사자료 등 불필요한 민감정보는 메모에 입력하지 마세요.</div>
      <div class="form-grid"><div class="fg"><label class="fl">직원 *</label><select id="er-employee"><option value="">선택</option>${options}</select></div>
      <div class="fg"><label class="fl">유형 *</label><select id="er-type"><option value="contract" ${record.type === "contract" ? "selected" : ""}>근로계약</option><option value="discipline" ${record.type === "discipline" ? "selected" : ""}>징계</option></select></div>
      <div class="fg"><label class="fl">계약/조치명 *</label><input id="er-title" maxlength="120" value="${esc(record.title)}" placeholder="예: 기간제 근로계약 / 견책"></div>
      <div class="fg"><label class="fl">상태 *</label><select id="er-status">${Object.entries(statusLabel).map(([v,l]) => `<option value="${v}" ${record.status === v ? "selected" : ""}>${l}</option>`).join("")}</select></div>
      <div class="fg"><label class="fl">시작일</label><input id="er-start" type="date" value="${esc(record.startDate)}"></div><div class="fg"><label class="fl">종료일</label><input id="er-end" type="date" value="${esc(record.endDate)}"></div>
      <div class="fg"><label class="fl">결정일</label><input id="er-decision" type="date" value="${esc(record.decisionDate)}"></div><div class="fg"><label class="fl">문서 참조</label><input id="er-document" maxlength="200" value="${esc(record.documentRef)}" placeholder="예: 전자결재 HR-2026-001"></div></div>
      <div class="fg"><label class="fl">관리 메모</label><textarea id="er-note" rows="4" maxlength="1000" placeholder="예: 갱신 검토일 2026-11-01 / 담당자 인사팀">${esc(record.note)}</textarea></div><div id="er-errors" class="alert alert-error" style="display:none"></div>
      </div><div class="modal-foot"><button class="btn btn-secondary" onclick="closeModal()">취소</button><button class="btn btn-primary" onclick="saveEmploymentRecord('${esc(old?.id || "")}')">저장</button></div></div>`);
  }

  async function save(id) {
    const old = (employmentRecords || []).find(r => String(r.id) === String(id));
    const input = { employeeId: $("#er-employee")?.value, type: $("#er-type")?.value, title: $("#er-title")?.value,
      status: $("#er-status")?.value, startDate: $("#er-start")?.value, endDate: $("#er-end")?.value,
      decisionDate: $("#er-decision")?.value, documentRef: $("#er-document")?.value, note: $("#er-note")?.value };
    const check = tools.validate(input), box = $("#er-errors");
    if (!check.ok) { if (box) { box.style.display = "block"; box.innerHTML = check.errors.map(esc).join("<br>"); } return; }
    const person = emp(input.employeeId);
    const ok = await root.askConfirmModal({ title: old ? "기록 수정" : "기록 등록", message: `${person?.name || "선택한 직원"}의 ${input.type === "contract" ? "근로계약" : "징계"} 기록을 저장합니다.`, confirmText: "저장", impacts: [{ label: "직원", value: `${person?.name || "-"} (${person?.empNo || "-"})` }, { label: "기록", value: input.title }, { label: "상태", value: statusLabel[input.status] }] });
    if (!ok) return;
    const next = tools.normalize({ ...input, id: old?.id || genId() }, old, currentUser);
    if (old) employmentRecords = employmentRecords.map(r => String(r.id) === String(old.id) ? next : r); else employmentRecords.push(next);
    root.closeModal(); root.autoSaveToServerIfEnabled(); root.showToast("계약·징계 기록을 저장했습니다.", "success"); render();
  }

  async function remove(id) {
    const record = (employmentRecords || []).find(r => String(r.id) === String(id)); if (!record) return;
    const person = emp(record.employeeId);
    const ok = await root.askConfirmModal({ title: "기록 삭제", message: "이 감사 원장 기록을 삭제하시겠습니까?", confirmText: "삭제", danger: true,
      impacts: [{ label: "직원", value: person?.name || "-" }, { label: "기록", value: record.title }], warnings: ["삭제 후에는 일반 화면에서 복구할 수 없습니다. 필요하면 먼저 데이터 백업을 받으세요."] });
    if (!ok) return; root._tombstone("employmentRecords", record.id); employmentRecords = employmentRecords.filter(r => String(r.id) !== String(id)); root.autoSaveToServerIfEnabled(); root.showToast("기록을 삭제했습니다.", "info"); render();
  }

  function render() {
    const c = root.document.getElementById("content"); if (!c) return;
    if (!currentUser || currentUser.role !== "admin") return root._pageAccessDenied();
    const rows = Array.isArray(employmentRecords) ? employmentRecords : [], sum = tools.summarize(rows);
    const body = rows.slice().sort((a,b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""))).map(r => { const e = emp(r.employeeId), due = r.type === "contract" ? tools.daysUntil(r.endDate) : null; return `<tr><td>${esc(e?.name || "삭제된 직원")}<div class="fz11 text-gray">${esc(e?.empNo || "-")} · ${esc(e?.dept || "-")}</div></td><td>${r.type === "contract" ? "근로계약" : "징계"}</td><td>${esc(r.title)}</td><td>${esc(r.type === "contract" ? `${r.startDate || "-"} ~ ${r.endDate || "-"}` : r.decisionDate || "-")}${due != null && due <= 30 ? `<div class="fz11 ${due < 0 ? "text-danger" : "text-warn"}">${due < 0 ? `${-due}일 경과` : `${due}일 남음`}</div>` : ""}</td><td><span class="badge">${statusLabel[r.status] || esc(r.status)}</span></td><td><button class="btn btn-ghost btn-sm" onclick="openEmploymentRecordEditor('${esc(r.id)}')">수정</button><button class="btn btn-ghost btn-sm text-danger" onclick="deleteEmploymentRecord('${esc(r.id)}')">삭제</button></td></tr>`; }).join("");
    c.innerHTML = `<div class="flex justify-between items-c mb3"><div><h2>🗃 계약·징계 원장</h2><div class="fz12 text-gray">관리자 전용 · 계약 만료와 인사 조치 이력을 안전하게 관리합니다.</div></div><button class="btn btn-primary" onclick="openEmploymentRecordEditor()">+ 기록 등록</button></div>
      <div class="kpi-grid mb3"><div class="kpi-card"><div class="kpi-label">전체 기록</div><div class="kpi-val">${sum.total}</div></div><div class="kpi-card"><div class="kpi-label">진행 계약</div><div class="kpi-val">${sum.activeContracts}</div></div><div class="kpi-card"><div class="kpi-label">30일 내 만료</div><div class="kpi-val" style="color:#b45309">${sum.due30}</div></div><div class="kpi-card"><div class="kpi-label">기한 경과</div><div class="kpi-val" style="color:#b91c1c">${sum.overdue}</div></div><div class="kpi-card"><div class="kpi-label">진행 징계</div><div class="kpi-val">${sum.activeDiscipline}</div></div></div>
      ${sum.due30 || sum.overdue ? `<div class="warn-note mb3">계약 검토 필요: 30일 내 만료 ${sum.due30}건, 기한 경과 ${sum.overdue}건입니다. 갱신·종료 여부를 확인하세요.</div>` : ""}
      <div class="card"><div class="table-wrap"><table><thead><tr><th>직원</th><th>유형</th><th>계약/조치명</th><th>기준일</th><th>상태</th><th>관리</th></tr></thead><tbody>${body || `<tr><td colspan="6" class="text-gray" style="text-align:center;padding:28px">등록된 기록이 없습니다.</td></tr>`}</tbody></table></div></div>`;
  }
  root.renderEmploymentRecordsPage = render; root.openEmploymentRecordEditor = openEditor; root.saveEmploymentRecord = save; root.deleteEmploymentRecord = remove;
})(typeof window !== "undefined" ? window : null);
