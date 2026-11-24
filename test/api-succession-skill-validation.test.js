// 승계계획(successionPlans)과 스킬 아키텍처(jobSkillProfiles, employeeSkillProfiles)의
// 서버 측 값 검증. 클라이언트 폼 검사만으로는 API 직접 호출로 잘못된 수준·가중치·
// 준비도 값이 저장될 수 있었다. 여기서는 잘못된 값이 거부되고(레코드 드롭),
// 정상 값은 그대로 저장되는지를 확인한다.
//
// mkdtemp의 DATA_FILE, 랜덤 PORT, child process `node server.js`만 사용한다.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer, bootstrapAdminAndLogin } = require("./support/start-server");

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
function now() { return new Date().toISOString(); }

function makePlan(id, overrides) {
  return {
    id, title: `승계-${id}`, planType: "position", incumbentId: "", jobProfileId: "",
    dept: "영업본부", targetDate: "", criticality: "high", riskOfLoss: "medium",
    impactOfLoss: "medium", notes: "", status: "active", candidates: [],
    createdAt: now(), updatedAt: now(), ...overrides,
  };
}
function makeJobProfile(id, overrides) {
  return {
    id, title: `직무-${id}`, dept: "영업본부", position: "", description: "",
    skills: [{ name: "PostgreSQL", level: 4, weight: 1 }], status: "active",
    createdAt: now(), updatedAt: now(), ...overrides,
  };
}
function makeEmpProfile(id, overrides) {
  return {
    id, empId: "admin1", skills: [{ name: "PostgreSQL", level: 4, evidence: "ERP DB 전환" }],
    verifiedBy: "admin1", verifiedAt: now(), updatedAt: now(), ...overrides,
  };
}

// 요청 한 번으로 한 컬렉션에 레코드 하나를 추가하고, 저장 후 해당 레코드가 존재하는지 확인
async function trySave(api, token, field, rec) {
  const d = await getData(api, token);
  const list = (d.data[field] || []).slice();
  list.push(rec);
  const r = await api("/save", auth(token, "POST", { _version: d.version, [field]: list }));
  assert.equal(r.status, 200, `${field} 저장 요청은 200이어야 함`);
  const check = await getData(api, token);
  return (check.data[field] || []).some(x => x.id === rec.id);
}

test("승계계획·스킬 검증 — 잘못된 값은 거부, 정상 값은 저장", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const api = (path, options) => fetch(server.baseUrl + path, options);
  const boot = await bootstrapAdminAndLogin(server, { loginId: "admin1", pw: "admin1-test-pw", name: "관리자1" });
  const token = boot.token;

  await t.test("successionPlans: 정상 계획은 저장", async () => {
    assert.equal(await trySave(api, token, "successionPlans", makePlan("sp-ok")), true);
  });
  await t.test("successionPlans: 중요도 enum 위반(criticality=critical) 거부", async () => {
    assert.equal(await trySave(api, token, "successionPlans", makePlan("sp-bad-crit", { criticality: "critical" })), false);
  });
  await t.test("successionPlans: 계획 유형 위반(planType=unknown) 거부", async () => {
    assert.equal(await trySave(api, token, "successionPlans", makePlan("sp-bad-type", { planType: "unknown" })), false);
  });
  await t.test("successionPlans: 후보 준비도 enum 위반(readiness=now) 거부", async () => {
    const plan = makePlan("sp-bad-ready", { candidates: [{ empId: "e1", rank: 1, readiness: "now", riskOfLoss: "low" }] });
    assert.equal(await trySave(api, token, "successionPlans", plan), false);
  });
  await t.test("successionPlans: 후보 순위 범위 위반(rank=0) 거부", async () => {
    const plan = makePlan("sp-bad-rank", { candidates: [{ empId: "e1", rank: 0, readiness: "ready_now", riskOfLoss: "low" }] });
    assert.equal(await trySave(api, token, "successionPlans", plan), false);
  });
  await t.test("successionPlans: 목표일 형식 위반 거부", async () => {
    assert.equal(await trySave(api, token, "successionPlans", makePlan("sp-bad-date", { targetDate: "2026-02-30" })), false);
  });

  await t.test("jobSkillProfiles: 정상 프로필은 저장", async () => {
    assert.equal(await trySave(api, token, "jobSkillProfiles", makeJobProfile("jp-ok")), true);
  });
  await t.test("jobSkillProfiles: 수준 범위 위반(level=9) 거부", async () => {
    const p = makeJobProfile("jp-bad-level", { skills: [{ name: "Go", level: 9, weight: 1 }] });
    assert.equal(await trySave(api, token, "jobSkillProfiles", p), false);
  });
  await t.test("jobSkillProfiles: 가중치 범위 위반(weight=0) 거부", async () => {
    const p = makeJobProfile("jp-bad-weight", { skills: [{ name: "Go", level: 3, weight: 0 }] });
    assert.equal(await trySave(api, token, "jobSkillProfiles", p), false);
  });
  await t.test("jobSkillProfiles: 스킬명 중복(대소문자 무시) 거부", async () => {
    const p = makeJobProfile("jp-dup", { skills: [{ name: "Go", level: 3, weight: 1 }, { name: "go", level: 2, weight: 1 }] });
    assert.equal(await trySave(api, token, "jobSkillProfiles", p), false);
  });

  await t.test("employeeSkillProfiles: 정상 프로필은 저장", async () => {
    assert.equal(await trySave(api, token, "employeeSkillProfiles", makeEmpProfile("ep-ok")), true);
  });
  await t.test("employeeSkillProfiles: 대상 직원 누락 거부", async () => {
    assert.equal(await trySave(api, token, "employeeSkillProfiles", makeEmpProfile("ep-noemp", { empId: "" })), false);
  });
  await t.test("employeeSkillProfiles: 수준 소수값(level=2.5) 거부", async () => {
    const p = makeEmpProfile("ep-frac", { skills: [{ name: "Go", level: 2.5, evidence: "" }] });
    assert.equal(await trySave(api, token, "employeeSkillProfiles", p), false);
  });
  await t.test("employeeSkillProfiles: 근거 길이 초과(300자 초과) 거부", async () => {
    const p = makeEmpProfile("ep-long", { skills: [{ name: "Go", level: 3, evidence: "가".repeat(301) }] });
    assert.equal(await trySave(api, token, "employeeSkillProfiles", p), false);
  });
});
