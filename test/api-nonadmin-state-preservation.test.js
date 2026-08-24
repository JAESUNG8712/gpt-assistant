// preserveServerOwnedStateForNonAdmin()(server.js, POST /save에서 _persistDataLocked()보다
// 먼저 실행됨)는 non-admin 액터가 employees/singleton 전사 정책을 통째로 위조하지 못하도록
// 저장본을 지키는 함수다. 2026-08-24 QA(에이전트 병렬 감사)로 이 함수가 "너무 거칠게" 막아
// 정당한 기능까지 죽이는 인접 버그 2건을 발견해 수정했다 — 이 파일은 그 회귀 테스트다.
//
// ① self-edit 필드 목록(SELF_EDITABLE_EMPLOYEE_FIELDS)에 name/birth가 빠져 있어,
//    openSelfEdit()가 admin/director/leader에게 노출하는 "인사 정보"(이름·생년월일) 수정이
//    항상 조용히 무시되고 있었다("저장되었습니다"는 뜨지만 실제로는 반영 안 됨).
// ② recordTombstones/roomReservationTombstones가 SINGLETON_FIELDS에 있다는 이유로 항상
//    저장본으로 통째로 되돌려지고 있어, non-admin의 삭제 요청(deleteKpi() 등)이 이 함수를
//    거치는 순간 무효화되고 있었다 — 삭제한 레코드가 곧바로 되살아났다.
//
// mkdtemp의 DATA_FILE, 랜덤 PORT, child process `node server.js`만 사용 — 실제 DB나
// 운영 데이터 파일은 이 테스트가 존재하는지조차 모른다.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer, bootstrapAdminAndLogin } = require("./support/start-server");

async function login(api, loginId, pw) {
  const r = await (await api("/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ loginId, pw }),
  })).json();
  assert.equal(r.ok, true, `${loginId} 로그인 실패: ${JSON.stringify(r)}`);
  return r.token;
}
function auth(token, method, body) {
  return {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  };
}
async function getData(api, token) {
  const r = await (await api("/data", { headers: { Authorization: `Bearer ${token}` } })).json();
  assert.equal(r.ok, true);
  return r;
}

test("preserveServerOwnedStateForNonAdmin — self-edit(name/birth) + 삭제 tombstone 회귀", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const api = (path, options) => fetch(server.baseUrl + path, options);

  const boot = await bootstrapAdminAndLogin(server, { loginId: "admin", pw: "admin-test-pw-1", name: "관리자" });
  const adminToken = boot.token;
  const initial = await getData(api, adminToken);

  const employees = [
    ...initial.data.employees,
    { id: "dir1", loginId: "dir1", pw: "dir1-pw-1", name: "사업부장", role: "director", active: true, dept: "개발본부", birth: "1980-01-01", address: "옛주소" },
    { id: "mem1", loginId: "mem1", pw: "mem1-pw-1", name: "팀원1", role: "member", active: true, dept: "개발본부", team: "A팀" },
    { id: "mem2", loginId: "mem2", pw: "mem2-pw-1", name: "팀원2", role: "member", active: true, dept: "개발본부", team: "A팀" },
  ];
  const kpiEntries = [
    { id: "kpiM1", userId: "mem1", year: 2026, title: "목표M1", weight: 30 },
    { id: "kpiM2", userId: "mem2", year: 2026, title: "목표M2", weight: 30 },
  ];
  const seed = await api("/save", auth(adminToken, "POST", { _version: initial.version, employees, kpiEntries, settings: { stage: "goal", evalYear: 2026 } }));
  assert.equal(seed.status, 200);

  const dir1Token = await login(api, "dir1", "dir1-pw-1");
  const mem1Token = await login(api, "mem1", "mem1-pw-1");
  const mem2Token = await login(api, "mem2", "mem2-pw-1");

  await t.test("director의 본인 정보 수정(이름·생년월일·주소)이 실제로 저장된다", async () => {
    const d = await getData(api, dir1Token);
    const updated = d.data.employees.map(e => e.id === "dir1"
      ? { ...e, name: "사업부장(개명)", birth: "1985-05-05", address: "새주소", updatedAt: new Date().toISOString() }
      : e);
    const r = await api("/save", auth(dir1Token, "POST", { _version: d.version, employees: updated }));
    assert.equal(r.status, 200);
    const check = await getData(api, adminToken);
    const dir1 = check.data.employees.find(e => e.id === "dir1");
    assert.equal(dir1.name, "사업부장(개명)");
    assert.equal(dir1.birth, "1985-05-05");
    assert.equal(dir1.address, "새주소");
  });

  await t.test("사원 본인은 여전히 role/salary 등 보호 필드는 위조할 수 없다(회귀 확인)", async () => {
    const d = await getData(api, mem1Token);
    const updated = d.data.employees.map(e => e.id === "mem1"
      ? { ...e, role: "admin", salary: 999999999, name: "팀원1(개명)", updatedAt: new Date().toISOString() }
      : e);
    const r = await api("/save", auth(mem1Token, "POST", { _version: d.version, employees: updated }));
    assert.equal(r.status, 200);
    const check = await getData(api, adminToken);
    const mem1 = check.data.employees.find(e => e.id === "mem1");
    assert.equal(mem1.role, "member");
    assert.notEqual(mem1.salary, 999999999);
    assert.equal(mem1.name, "팀원1(개명)"); // name은 이제 self-editable — 정상 반영
  });

  await t.test("사원 본인의 KPI 목표 삭제(tombstone)가 실제로 반영된다(되살아나지 않음)", async () => {
    const d = await getData(api, mem1Token);
    const remaining = d.data.kpiEntries.filter(k => k.id !== "kpiM1");
    const r = await api("/save", auth(mem1Token, "POST", {
      _version: d.version, kpiEntries: remaining, recordTombstones: { kpiEntries: [{ id: "kpiM1", ts: Date.now() }] },
    }));
    assert.equal(r.status, 200);
    const check = await getData(api, adminToken);
    assert.equal(check.data.kpiEntries.some(k => k.id === "kpiM1"), false);
  });

  await t.test("서로 다른 사원의 동시 삭제가 서로를 지우지 않는다(tombstone 병합)", async () => {
    const d = await getData(api, mem2Token);
    const remaining = d.data.kpiEntries.filter(k => k.id !== "kpiM2");
    const r = await api("/save", auth(mem2Token, "POST", {
      _version: d.version, kpiEntries: remaining, recordTombstones: { kpiEntries: [{ id: "kpiM2", ts: Date.now() }] },
    }));
    assert.equal(r.status, 200);
    const check = await getData(api, adminToken);
    assert.equal(check.data.kpiEntries.some(k => k.id === "kpiM1"), false, "kpiM1은 여전히 삭제 상태여야 한다");
    assert.equal(check.data.kpiEntries.some(k => k.id === "kpiM2"), false, "kpiM2도 삭제돼야 한다");
  });

  await t.test("삭제 후 무관한 저장(tombstone 미포함)을 해도 삭제된 레코드가 되살아나지 않는다", async () => {
    const d = await getData(api, mem1Token);
    const r = await api("/save", auth(mem1Token, "POST", { _version: d.version, employees: d.data.employees }));
    assert.equal(r.status, 200);
    const check = await getData(api, adminToken);
    assert.equal(check.data.kpiEntries.some(k => k.id === "kpiM1"), false);
  });

  await t.test("non-admin은 여전히 전사 settings를 통째로 위조할 수 없다(기존 보호 회귀 없음)", async () => {
    const d = await getData(api, mem1Token);
    const forged = { ...d.data.settings, evilPolicy: "hacked" };
    const r = await api("/save", auth(mem1Token, "POST", { _version: d.version, settings: forged }));
    assert.equal(r.status, 200);
    const check = await getData(api, adminToken);
    assert.equal(check.data.settings.evilPolicy, undefined);
    assert.equal(check.data.settings.stage, "goal");
  });
});
