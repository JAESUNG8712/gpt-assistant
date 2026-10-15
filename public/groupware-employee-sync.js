(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.groupwareEmployeeSync = api;
})(typeof window !== "undefined" ? window : null, function () {
  "use strict";

  const FIELD_ALIASES = {
    company: ["회사", "회사명", "company"],
    dept: ["부서", "부서명", "소속", "조직", "department"],
    team: ["팀", "팀명", "team"],
    rank: ["직급", "직급명", "rank", "grade"],
    position: ["직책", "직책명", "position", "title"],
    displayName: ["사원명id", "사원명", "사용자명id", "사용자명", "성명", "이름", "name"],
    groupwareId: ["그룹웨어id", "사용자id", "로그인id", "메일id", "mailid", "userid", "id"],
    empNo: ["사번", "erp사번", "직원번호", "사원번호", "employeeno", "empno"],
    employment: ["재직여부", "재직상태", "상태", "employmentstatus"],
    enabled: ["사용여부", "계정상태", "enabled"],
    license: ["라이선스", "license"],
  };

  function norm(value) {
    return String(value == null ? "" : value).trim().toLowerCase().replace(/[\s_()\-./]+/g, "");
  }

  function normalizeId(value) {
    return String(value == null ? "" : value).trim().toLowerCase();
  }

  function valueByAliases(row, aliases) {
    const keyed = new Map(Object.entries(row || {}).map(([key, value]) => [norm(key), value]));
    for (const alias of aliases) {
      const value = keyed.get(norm(alias));
      if (value != null && String(value).trim() !== "") return String(value).trim();
    }
    return "";
  }

  function splitDisplayName(value) {
    const text = String(value || "").trim();
    const match = text.match(/^(.*?)\s*\(([^()]+)\)\s*$/);
    return match ? { name: match[1].trim(), groupwareId: match[2].trim() } : { name: text, groupwareId: "" };
  }

  function parseEmployment(value) {
    const v = norm(value);
    if (!v) return null;
    if (["퇴직", "퇴사", "재직아님", "inactive", "retired", "false", "0"].includes(v)) return false;
    if (["재직", "근무", "active", "true", "1"].includes(v)) return true;
    return null;
  }

  function parseEnabled(value) {
    const v = norm(value);
    if (!v) return null;
    if (["미사용", "사용안함", "비활성", "disabled", "false", "0"].includes(v)) return false;
    if (["사용", "활성", "enabled", "true", "1"].includes(v)) return true;
    return null;
  }

  function parseGroupwareRows(rows) {
    const parsed = [];
    const errors = [];
    (Array.isArray(rows) ? rows : []).forEach((row, index) => {
      const rawDisplayName = valueByAliases(row, FIELD_ALIASES.displayName);
      const display = splitDisplayName(rawDisplayName);
      const name = display.name;
      const groupwareId = valueByAliases(row, FIELD_ALIASES.groupwareId) || display.groupwareId;
      if (!name) {
        errors.push({ row: index + 2, message: "사원명이 없습니다." });
        return;
      }
      parsed.push({
        sourceRow: index + 2,
        company: valueByAliases(row, FIELD_ALIASES.company),
        name,
        groupwareId: normalizeId(groupwareId),
        empNo: valueByAliases(row, FIELD_ALIASES.empNo),
        dept: valueByAliases(row, FIELD_ALIASES.dept),
        team: valueByAliases(row, FIELD_ALIASES.team),
        rank: valueByAliases(row, FIELD_ALIASES.rank),
        position: valueByAliases(row, FIELD_ALIASES.position),
        active: parseEmployment(valueByAliases(row, FIELD_ALIASES.employment)),
        enabled: parseEnabled(valueByAliases(row, FIELD_ALIASES.enabled)),
        license: valueByAliases(row, FIELD_ALIASES.license),
      });
    });
    return { rows: parsed, errors };
  }

  function pushIndex(index, key, employee) {
    if (!key) return;
    const list = index.get(key) || [];
    list.push(employee);
    index.set(key, list);
  }

  function buildIndexes(employees) {
    const indexes = { empNo: new Map(), groupwareId: new Map(), loginId: new Map(), nameDept: new Map() };
    (employees || []).forEach(employee => {
      pushIndex(indexes.empNo, normalizeId(employee.empNo), employee);
      pushIndex(indexes.groupwareId, normalizeId(employee.groupwareId), employee);
      pushIndex(indexes.loginId, normalizeId(employee.loginId), employee);
      pushIndex(indexes.nameDept, `${norm(employee.name)}|${norm(employee.dept)}`, employee);
    });
    return indexes;
  }

  function uniqueCandidate(index, key) {
    const list = key ? (index.get(key) || []) : [];
    return list.length === 1 ? { employee: list[0], ambiguous: false } : { employee: null, ambiguous: list.length > 1 };
  }

  function findMatch(source, indexes) {
    const attempts = [
      ["사번", indexes.empNo, normalizeId(source.empNo)],
      ["기존 그룹웨어 ID", indexes.groupwareId, normalizeId(source.groupwareId)],
      ["로그인 ID", indexes.loginId, normalizeId(source.groupwareId)],
      ["이름+부서", indexes.nameDept, `${norm(source.name)}|${norm(source.dept)}`],
    ];
    for (const [method, index, key] of attempts) {
      if (!key || key === "|") continue;
      const result = uniqueCandidate(index, key);
      if (result.ambiguous) return { employee: null, method, ambiguous: true };
      if (result.employee) return { employee: result.employee, method, ambiguous: false };
    }
    return { employee: null, method: "", ambiguous: false };
  }

  function changedFields(employee, source) {
    const changes = [];
    const directoryFields = ["name", "dept", "team", "rank", "position"];
    directoryFields.forEach(field => {
      if (source[field] && String(employee[field] || "").trim() !== String(source[field]).trim()) {
        changes.push({ field, before: employee[field] || "", after: source[field] });
      }
    });
    if (source.groupwareId && normalizeId(employee.groupwareId) !== normalizeId(source.groupwareId)) {
      changes.push({ field: "groupwareId", before: employee.groupwareId || "", after: source.groupwareId });
    }
    return changes;
  }

  function buildGroupwareSyncPlan(sourceRows, employees) {
    const indexes = buildIndexes(employees);
    const seenSourceIds = new Map();
    const seenTargets = new Map();
    const plan = [];
    (sourceRows || []).forEach(source => {
      const sourceKey = normalizeId(source.empNo || source.groupwareId);
      if (sourceKey) {
        const previous = seenSourceIds.get(sourceKey);
        if (previous) {
          plan.push({ status: "blocked", source, reason: `원본 식별자 중복(행 ${previous}, ${source.sourceRow})`, changes: [] });
          return;
        }
        seenSourceIds.set(sourceKey, source.sourceRow);
      }
      const match = findMatch(source, indexes);
      if (match.ambiguous) {
        plan.push({ status: "ambiguous", source, reason: `${match.method}가 여러 직원과 일치합니다.`, changes: [] });
        return;
      }
      if (!match.employee) {
        plan.push({ status: "unmatched", source, reason: "안전하게 일치하는 HR 직원을 찾지 못했습니다.", changes: [] });
        return;
      }
      const targetKey = String(match.employee.id);
      if (seenTargets.has(targetKey)) {
        plan.push({ status: "blocked", source, reason: `같은 HR 직원이 원본 여러 행과 일치합니다(행 ${seenTargets.get(targetKey)}, ${source.sourceRow}).`, changes: [] });
        return;
      }
      seenTargets.set(targetKey, source.sourceRow);
      const changes = changedFields(match.employee, source);
      const warnings = [];
      if (source.enabled === false && source.active !== false) warnings.push("그룹웨어 계정은 미사용이지만 재직상태는 퇴직으로 변경하지 않습니다.");
      if (source.active != null && Boolean(match.employee.active !== false) !== source.active) warnings.push("재직상태가 다릅니다. 퇴직일·입사일 확인이 필요해 자동 변경하지 않습니다.");
      plan.push({
        status: changes.length ? "update" : "noop",
        source,
        employeeId: match.employee.id,
        employeeName: match.employee.name,
        method: match.method,
        changes,
        warnings,
      });
    });
    return plan;
  }

  function applyGroupwareSyncPlan(employees, plan, selectedEmployeeIds, now) {
    const selected = new Set((selectedEmployeeIds || []).map(String));
    const byId = new Map((plan || []).filter(item => item.status === "update" && selected.has(String(item.employeeId))).map(item => [String(item.employeeId), item]));
    const timestamp = now || new Date().toISOString();
    const date = timestamp.slice(0, 10);
    let updated = 0;
    const next = (employees || []).map(employee => {
      const item = byId.get(String(employee.id));
      if (!item) return employee;
      const out = { ...employee, updatedAt: timestamp };
      item.changes.forEach(change => { out[change.field] = change.after; });
      const summary = item.changes.map(change => `${change.field}: ${String(change.before || "-")} → ${String(change.after || "-")}`).join("; ");
      out.hrHistory = [...(employee.hrHistory || []), {
        id: `gw-${String(employee.id)}-${Date.parse(timestamp) || Date.now()}`,
        type: "groupware_sync",
        date,
        desc: "그룹웨어 사원정보 동기화",
        before: "",
        after: summary,
        note: `매칭: ${item.method}`,
        source: "groupware_sync",
        applied: true,
        createdAt: timestamp,
      }];
      updated += 1;
      return out;
    });
    return { employees: next, updated };
  }

  return { parseGroupwareRows, buildGroupwareSyncPlan, applyGroupwareSyncPlan, splitDisplayName };
});

(function attachBrowserUi(root) {
  if (!root || !root.document) return;

  const esc = value => typeof root.h === "function" ? root.h(String(value == null ? "" : value)) : String(value == null ? "" : value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const fieldLabels = { name: "성명", dept: "부서", team: "팀", rank: "직급", position: "직책", groupwareId: "그룹웨어 ID" };

  function ensureXlsx() {
    if (root.XLSX) return Promise.resolve(root.XLSX);
    return new Promise((resolve, reject) => {
      const existing = root.document.querySelector('script[data-groupware-xlsx="1"]');
      if (existing) {
        existing.addEventListener("load", () => resolve(root.XLSX), { once: true });
        existing.addEventListener("error", () => reject(new Error("엑셀 처리 모듈을 불러오지 못했습니다.")), { once: true });
        return;
      }
      const script = root.document.createElement("script");
      script.dataset.groupwareXlsx = "1";
      script.src = "https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js";
      script.onload = () => resolve(root.XLSX);
      script.onerror = () => reject(new Error("엑셀 처리 모듈을 불러오지 못했습니다."));
      root.document.head.appendChild(script);
    });
  }

  async function readRows(file) {
    const XLSX = await ensureXlsx();
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: "array", cellDates: false });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) throw new Error("엑셀 시트를 찾지 못했습니다.");
    return XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: "", raw: false });
  }

  function planStatus(item) {
    return { update: ["변경", "green"], noop: ["일치", "gray"], unmatched: ["미일치", "orange"], ambiguous: ["중복", "red"], blocked: ["차단", "red"] }[item.status] || [item.status, "gray"];
  }

  function renderPreview(plan, parseErrors) {
    root._groupwareEmployeeSyncPlan = plan;
    const updates = plan.filter(item => item.status === "update");
    const noops = plan.filter(item => item.status === "noop");
    const unresolved = plan.filter(item => ["unmatched", "ambiguous", "blocked"].includes(item.status));
    const warningCount = plan.reduce((sum, item) => sum + (item.warnings || []).length, 0) + parseErrors.length;
    const rows = plan.slice(0, 200).map((item, index) => {
      const [status, tone] = planStatus(item);
      const changeText = item.changes?.length ? item.changes.map(change => `${esc(fieldLabels[change.field] || change.field)}: ${esc(change.before || "-")} → ${esc(change.after || "-")}`).join("<br>") : esc(item.reason || "변경 없음");
      const warnings = (item.warnings || []).map(warning => `<div style="color:#b45309">⚠ ${esc(warning)}</div>`).join("");
      return `<tr><td style="text-align:center">${item.status === "update" ? `<input type="checkbox" class="gw-sync-check" data-index="${index}" checked>` : "-"}</td><td>${root.badge ? root.badge(status, tone) : esc(status)}</td><td><strong>${esc(item.source.name)}</strong><div class="fz11 text-gray">${esc(item.source.groupwareId || item.source.empNo || "식별자 없음")}</div></td><td>${esc(item.source.dept || "-")}<div class="fz11 text-gray">${esc(item.source.rank || "")} ${esc(item.source.position || "")}</div></td><td>${esc(item.employeeName || "-")}<div class="fz11 text-gray">${esc(item.method || "")}</div></td><td class="fz11">${changeText}${warnings}</td></tr>`;
    }).join("");
    root.openModal(`<div class="modal-box" style="max-width:1100px"><div class="modal-head"><h3>그룹웨어 사원정보 동기화 미리보기</h3></div><div class="modal-body"><div class="info-note mb3">그룹웨어의 성명·부서·팀·직급·직책·그룹웨어 ID만 비교합니다. 사번·로그인 ID·비밀번호·급여·생년월일·입사일은 변경하지 않습니다. 재직상태가 다르면 퇴직일 확인을 위해 자동 반영하지 않습니다.</div><div class="flex gap3 wrap mb3"><span>변경 <strong>${updates.length}명</strong></span><span>이미 일치 <strong>${noops.length}명</strong></span><span style="color:#dc2626">확인 필요 <strong>${unresolved.length}명</strong></span><span style="color:#b45309">경고 <strong>${warningCount}건</strong></span></div>${parseErrors.length ? `<div class="warn-note mb3">파일 행 오류 ${parseErrors.length}건: ${parseErrors.slice(0, 5).map(error => `${error.row}행 ${esc(error.message)}`).join(" · ")}</div>` : ""}<div class="tbl-wrap" style="max-height:55vh;overflow:auto"><table><thead><tr><th>선택</th><th>상태</th><th>그룹웨어</th><th>소속/직위</th><th>HR 매칭</th><th>변경/경고</th></tr></thead><tbody>${rows || `<tr><td colspan="6" class="p-empty">읽을 수 있는 직원 행이 없습니다.</td></tr>`}${plan.length > 200 ? `<tr><td colspan="6" class="tc text-gray">화면에는 200건까지만 표시되며 전체 계획은 그대로 검증됩니다.</td></tr>` : ""}</tbody></table></div></div><div class="modal-foot"><button class="btn btn-secondary" onclick="closeModal()">취소</button><button class="btn btn-primary" ${updates.length ? "" : "disabled"} onclick="confirmGroupwareEmployeeSync()">선택 항목 반영</button></div></div>`);
  }

  root.handleGroupwareEmployeeImport = async function handleGroupwareEmployeeImport(input) {
    if (!currentUser || currentUser.role !== "admin") { root.showToast("관리자만 그룹웨어 사원정보를 동기화할 수 있습니다.", "error"); return; }
    const file = input && input.files && input.files[0];
    if (!file) return;
    input.value = "";
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error("파일은 5MB 이하여야 합니다.");
      const rawRows = await readRows(file);
      if (rawRows.length > 5000) throw new Error("한 번에 최대 5,000명까지 처리할 수 있습니다.");
      const parsed = root.groupwareEmployeeSync.parseGroupwareRows(rawRows);
      const sourceCompanies = [...new Set(parsed.rows.map(row => row.company).filter(Boolean))];
      const expectedCompany = String((typeof settings !== "undefined" && settings.companyName) || "").trim();
      if (sourceCompanies.length > 1) throw new Error(`여러 회사 데이터가 섞여 있습니다: ${sourceCompanies.join(", ")}`);
      if (sourceCompanies.length === 1 && expectedCompany && normCompany(sourceCompanies[0]) !== normCompany(expectedCompany)) {
        throw new Error(`회사 불일치: 파일은 '${sourceCompanies[0]}', 현재 HR은 '${expectedCompany}'입니다.`);
      }
      const plan = root.groupwareEmployeeSync.buildGroupwareSyncPlan(parsed.rows, employees);
      renderPreview(plan, parsed.errors);
    } catch (error) {
      console.error(error);
      root.showToast(`그룹웨어 파일을 읽지 못했습니다: ${error.message}`, "error");
    }
  };

  root.confirmGroupwareEmployeeSync = async function confirmGroupwareEmployeeSync() {
    if (!currentUser || currentUser.role !== "admin") { root.showToast("관리자만 그룹웨어 사원정보를 동기화할 수 있습니다.", "error"); return; }
    const plan = root._groupwareEmployeeSyncPlan || [];
    const selectedIndexes = Array.from(root.document.querySelectorAll(".gw-sync-check:checked")).map(input => Number(input.dataset.index));
    const selectedItems = selectedIndexes.map(index => plan[index]).filter(item => item && item.status === "update");
    if (!selectedItems.length) { root.showToast("반영할 변경 항목을 선택하세요.", "error"); return; }
    const selectedIds = selectedItems.map(item => item.employeeId);
    const changedFieldCount = selectedItems.reduce((sum, item) => sum + item.changes.length, 0);
    const ok = await root.askConfirmModal({
      title: "그룹웨어 사원정보 동기화",
      message: "미리보기에서 선택한 직원의 조직·직위 정보를 반영합니다.",
      impacts: [
        { label: "대상 직원", value: `${selectedItems.length}명`, tone: "warn" },
        { label: "변경 필드", value: `${changedFieldCount}개` },
        { label: "보존", value: "사번·로그인·비밀번호·급여·개인정보", tone: "success" },
      ],
      warnings: ["재직상태 불일치는 자동 반영하지 않습니다.", "적용 이력은 각 직원의 인사 변동 이력에 기록됩니다."],
      confirmText: "동기화 실행",
    });
    if (!ok) return;
    const result = root.groupwareEmployeeSync.applyGroupwareSyncPlan(employees, plan, selectedIds);
    employees = result.employees;
    const current = employees.find(employee => String(employee.id) === String(currentUser && currentUser.id));
    if (current) currentUser = current;
    root.closeModal();
    root.autoSaveToServerIfEnabled();
    root.renderHRList();
    root.showToast(`${result.updated}명의 그룹웨어 정보를 반영했습니다.`, "success");
  };

  function normCompany(value) {
    return String(value || "").toLowerCase().replace(/\(주\)|주식회사|[\s._-]+/g, "");
  }
})(typeof window !== "undefined" ? window : null);
