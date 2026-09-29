"use strict";

// 포지션 마스터와 채용공고의 정원 통제 회귀 테스트. 임시 JSON 저장소와 랜덤 포트만
// 사용하므로 운영 DB/운영 채용자료는 읽거나 변경하지 않는다.
const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer, bootstrapAdminAndLogin } = require("./support/start-server");

function auth(token, method, body) {
  return {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

test("채용 정원·포지션 통제 — 연결, 초과 차단, 수정, 동시 요청", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const api = (path, options) => fetch(server.baseUrl + path, options);
  const { token } = await bootstrapAdminAndLogin(server, {
    loginId: "position-admin", pw: "position-admin-test-pw", name: "정원 관리자",
  });

  const initial = await (await api("/data", { headers: { Authorization: `Bearer ${token}` } })).json();
  const adminId = initial.data.employees.find(e => e.loginId === "position-admin").id;
  const now = new Date().toISOString();
  const positions = [
    { id: "pos-main", code: "POS-DX-001", title: "ERP PM", dept: "DX사업본부", team: "ERP팀", targetHeadcount: 2, incumbentIds: [adminId], positionType: "regular", status: "active", createdAt: now, updatedAt: now },
    { id: "pos-race", code: "POS-DX-002", title: "ERP 개발", dept: "DX사업본부", team: "개발팀", targetHeadcount: 1, incumbentIds: [], positionType: "regular", status: "active", createdAt: now, updatedAt: now },
    { id: "pos-off", code: "POS-DX-003", title: "중단 포지션", dept: "DX사업본부", team: "", targetHeadcount: 1, incumbentIds: [], positionType: "regular", status: "inactive", createdAt: now, updatedAt: now },
  ];
  const seeded = await api("/save", auth(token, "POST", { _version: initial.version, data: { ...initial.data, workforcePositions: positions } }));
  assert.equal(seeded.status, 200, await seeded.text());

  await t.test("연결된 포지션의 조직을 서버가 기준값으로 고정한다", async () => {
    const r = await api("/api/recruit/jobs", auth(token, "POST", {
      title: "ERP PM 채용", department: "임의조직", team: "임의팀", headcount: 1, positionId: "pos-main",
    }));
    const raw = await r.text();
    assert.equal(r.status, 200, raw);
    const body = JSON.parse(raw);
    assert.equal(body.job.department, "DX사업본부");
    assert.equal(body.job.team, "ERP팀");
    assert.equal(body.job.positionCode, "POS-DX-001");
    t.diagnostic(`jobId=${body.job.id}`);
  });

  let mainJob;
  await t.test("잔여 승인 정원을 초과한 추가 채용공고는 409로 차단한다", async () => {
    const jobs = await (await api("/api/recruit/jobs", { headers: { Authorization: `Bearer ${token}` } })).json();
    mainJob = jobs.jobs.find(j => j.positionId === "pos-main");
    assert.ok(mainJob);
    const r = await api("/api/recruit/jobs", auth(token, "POST", {
      title: "정원 초과", department: "DX사업본부", headcount: 1, positionId: "pos-main",
    }));
    assert.equal(r.status, 409);
    const body = await r.json();
    assert.equal(body.code, "POSITION_CAPACITY_EXCEEDED");
  });

  await t.test("기존 공고 수정은 자기 예약 정원을 중복 차감하지 않는다", async () => {
    const r = await api("/api/recruit/jobs", auth(token, "POST", {
      id: mainJob.id, title: "ERP PM 채용(수정)", headcount: 1, positionId: "pos-main",
    }));
    const raw = await r.text();
    assert.equal(r.status, 200, raw);
    const body = JSON.parse(raw);
    assert.equal(body.job.headcount, 1);
    assert.equal(body.job.department, "DX사업본부");
  });

  await t.test("비활성 포지션에는 채용공고를 연결할 수 없다", async () => {
    const r = await api("/api/recruit/jobs", auth(token, "POST", {
      title: "중단 포지션 채용", department: "DX사업본부", headcount: 1, positionId: "pos-off",
    }));
    assert.equal(r.status, 409);
    const body = await r.json();
    assert.equal(body.code, "POSITION_CAPACITY_EXCEEDED");
  });

  await t.test("동일한 마지막 한 자리에 동시 요청해도 정확히 하나만 성공한다", async () => {
    const payload = n => auth(token, "POST", {
      title: `동시 채용 ${n}`, department: "DX사업본부", headcount: 1, positionId: "pos-race",
    });
    const results = await Promise.all([
      api("/api/recruit/jobs", payload(1)), api("/api/recruit/jobs", payload(2)),
    ]);
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  });
});

test("포지션 일괄 저장 — 요청 내부 중복 코드/재직자 이중 배정을 드롭한다", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const api = (path, options) => fetch(server.baseUrl + path, options);
  const { token } = await bootstrapAdminAndLogin(server, {
    loginId: "position-admin-2", pw: "position-admin-test-pw-2", name: "정원 관리자2",
  });
  const initial = await (await api("/data", { headers: { Authorization: `Bearer ${token}` } })).json();
  const empId = initial.data.employees.find(e => e.loginId === "position-admin-2").id;
  const member = { id: "position-member", loginId: "position-member", pw: "position-member-test-pw", name: "일반 직원", role: "member", active: true, dept: "테스트본부", team: "테스트팀", menuPerms: {} };
  const base = { title: "테스트 직무", dept: "테스트본부", team: "", targetHeadcount: 1, incumbentIds: [empId], positionType: "regular", status: "active" };
  const r = await api("/save", auth(token, "POST", {
    _version: initial.version,
    data: { ...initial.data, employees: [...initial.data.employees, member], workforcePositions: [
      { ...base, id: "dup-1", code: "POS-DUP-001" },
      { ...base, id: "dup-2", code: "POS-DUP-001" },
      { ...base, id: "dup-3", code: "POS-OTHER-001" },
    ] },
  }));
  assert.equal(r.status, 200, await r.text());
  const saved = await (await api("/data", { headers: { Authorization: `Bearer ${token}` } })).json();
  assert.equal(saved.data.workforcePositions.length, 1);
  assert.equal(saved.data.workforcePositions[0].id, "dup-1");

  await t.test("비관리자 응답에는 포지션 정원 원장이 없고 직접 쓰기·삭제도 반영되지 않는다", async () => {
    const login = await api("/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ loginId: member.loginId, pw: member.pw }),
    });
    const memberToken = (await login.json()).token;
    assert.ok(memberToken);
    const memberView = await (await api("/data", { headers: { Authorization: `Bearer ${memberToken}` } })).json();
    assert.deepEqual(memberView.data.workforcePositions, []);
    const forged = { ...base, id: "forged", code: "POS-FORGED-001", incumbentIds: [] };
    const write = await api("/save", auth(memberToken, "POST", {
      _version: memberView.version,
      data: { workforcePositions: [forged], recordTombstones: { workforcePositions: [{ id: "dup-1", ts: Date.now() }] } },
    }));
    assert.equal(write.status, 200);
    const final = await (await api("/data", { headers: { Authorization: `Bearer ${token}` } })).json();
    assert.equal(final.data.workforcePositions.some(p => p.id === "forged"), false);
    assert.equal(final.data.workforcePositions.some(p => p.id === "dup-1"), true);
  });
});
