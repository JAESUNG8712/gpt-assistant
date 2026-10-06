const test = require("node:test");
const assert = require("node:assert/strict");
const sync = require("../public/groupware-employee-sync.js");

test("그룹웨어 행을 화면 내보내기 형식에서 안전하게 읽는다", () => {
  const result = sync.parseGroupwareRows([{
    회사: "LS티라유텍(주)", 부서: "인사팀", 직급: "부장", 직책: "팀장",
    "사원명(ID)": "이재성(jslee2)", "Mail ID": "jslee2", 재직여부: "재직", 사용여부: "사용",
  }]);
  assert.equal(result.errors.length, 0);
  assert.deepEqual(result.rows[0], {
    sourceRow: 2, company: "LS티라유텍(주)", name: "이재성", groupwareId: "jslee2", empNo: "",
    dept: "인사팀", team: "", rank: "부장", position: "팀장", active: true, enabled: true, license: "",
  });
});

test("매칭은 사번을 우선하고 원본에 없는 민감 필드는 변경하지 않는다", () => {
  const employees = [{ id: 1, empNo: "1001", loginId: "1001", pw: "hash", name: "홍길동", dept: "구부서", team: "A팀", rank: "과장", position: "", salary: 50000000, birth: "1990-01-01", active: true }];
  const source = [{ sourceRow: 2, empNo: "1001", groupwareId: "hong", name: "홍길동", dept: "신부서", team: "", rank: "차장", position: "팀장", active: true, enabled: true }];
  const plan = sync.buildGroupwareSyncPlan(source, employees);
  assert.equal(plan[0].status, "update");
  assert.equal(plan[0].method, "사번");
  assert.deepEqual(plan[0].changes.map(c => c.field), ["dept", "rank", "position", "groupwareId"]);
  const applied = sync.applyGroupwareSyncPlan(employees, plan, [1], "2026-10-06T01:02:03.000Z");
  assert.equal(applied.updated, 1);
  assert.equal(applied.employees[0].dept, "신부서");
  assert.equal(applied.employees[0].team, "A팀", "원본에 없는 팀은 보존");
  assert.equal(applied.employees[0].salary, 50000000);
  assert.equal(applied.employees[0].birth, "1990-01-01");
  assert.equal(applied.employees[0].loginId, "1001");
  assert.equal(applied.employees[0].pw, "hash");
  assert.equal(applied.employees[0].hrHistory.at(-1).source, "groupware_sync");
});

test("동명이인과 식별자 중복은 자동 반영하지 않는다", () => {
  const employees = [
    { id: 1, name: "김민수", dept: "개발팀", loginId: "1001", active: true },
    { id: 2, name: "김민수", dept: "개발팀", loginId: "1002", active: true },
  ];
  const rows = [
    { sourceRow: 2, name: "김민수", dept: "개발팀", groupwareId: "", empNo: "" },
    { sourceRow: 3, name: "박서연", dept: "재무팀", groupwareId: "same", empNo: "" },
    { sourceRow: 4, name: "최서연", dept: "인사팀", groupwareId: "same", empNo: "" },
  ];
  const plan = sync.buildGroupwareSyncPlan(rows, employees);
  assert.equal(plan[0].status, "ambiguous");
  assert.equal(plan[1].status, "unmatched");
  assert.equal(plan[2].status, "blocked");
});

test("계정 미사용과 재직상태 차이는 자동 퇴직으로 처리하지 않는다", () => {
  const employees = [{ id: 1, name: "홍길동", dept: "인사팀", loginId: "hong", active: true }];
  const plan = sync.buildGroupwareSyncPlan([{ sourceRow: 2, name: "홍길동", dept: "인사팀", groupwareId: "hong", active: false, enabled: false }], employees);
  assert.equal(plan[0].status, "update");
  assert.deepEqual(plan[0].changes.map(change => change.field), ["groupwareId"]);
  assert.equal(plan[0].warnings.length, 1);
  assert.match(plan[0].warnings.join(" "), /자동 변경하지 않습니다/);
  const applied = sync.applyGroupwareSyncPlan(employees, plan, [1], "2026-10-06T01:02:03.000Z");
  assert.equal(applied.employees[0].active, true);
});

test("동기화 적용은 선택한 직원만 변경하고 기존 원본 배열은 훼손하지 않는다", () => {
  const employees = [
    { id: 1, name: "김하나", dept: "경영지원", loginId: "1001", salary: 60000000, active: true },
    { id: 2, name: "이두리", dept: "영업", loginId: "1002", salary: 70000000, active: true },
  ];
  const snapshot = structuredClone(employees);
  const rows = [
    { sourceRow: 2, name: "김하나", dept: "인사팀", groupwareId: "1001", empNo: "" },
    { sourceRow: 3, name: "이두리", dept: "전략영업", groupwareId: "1002", empNo: "" },
  ];
  const plan = sync.buildGroupwareSyncPlan(rows, employees);
  const applied = sync.applyGroupwareSyncPlan(employees, plan, [2], "2026-10-06T02:03:04.000Z");

  assert.deepEqual(employees, snapshot, "미리보기·적용 과정에서 원본 배열을 직접 변경하면 안 됨");
  assert.equal(applied.updated, 1);
  assert.equal(applied.employees[0].dept, "경영지원");
  assert.equal(applied.employees[1].dept, "전략영업");
  assert.equal(applied.employees[1].salary, 70000000);
});
