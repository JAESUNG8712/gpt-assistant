"use strict";

// "구조적 한계 #2"(회계·ERP·PMS 등 대량 조회 API가 menuPerms로 좁혀지지 않던 문제)의 채용
// 모듈 증분 — 조사 결과 GET .../recruit/jobs·/candidates·/candidates/:id·
// /candidates/:id/resume·/interviews는 이미 부서 스코프(_recruitCanViewJob)·면접관 열람권
// (_recruitCanViewCandidate/_recruitIsInterviewPrivileged)으로 row-level 필터링이 돼
// 있고, "지원자 관리"와 "면접 일정/평가 입력" 등 서로 다른 화면이 정당하게 공유해야
// 하는 구조라(면접관은 recruit-candidates 접근권이 없어도 담당 지원자 상세는 봐야 함)
// PMS의 projects/worklogs와 동일한 이유로 게이팅 대상에서 제외했다. 유일하게 단일 화면
// 전용이었던 CSV 내보내기(candidates/export)와 채용 현황 대시보드(dashboard)만 게이팅.
const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer, bootstrapAdminAndLogin } = require("./support/start-server");

async function login(api, loginId, pw) {
  const response = await api("/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ loginId, pw }),
  });
  const body = await response.json();
  assert.equal(body.ok, true, `${loginId} 로그인 실패`);
  return body.token;
}

function auth(token, method, body) {
  return {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  };
}

test("채용: candidates/export·dashboard 게이팅 + jobs/candidates/interviews는 이미 안전해 미변경", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const api = (path, options) => fetch(server.baseUrl + path, options);

  const boot = await bootstrapAdminAndLogin(server, { loginId: "admin1", pw: "admin1-test-pw", name: "관리자1" });
  const adminToken = boot.token;

  const initial = await (await api("/data", { headers: { Authorization: `Bearer ${adminToken}` } })).json();
  const employees = [
    ...initial.data.employees.map(e => e.loginId === "admin1"
      ? { ...e, menuPerms: { "recruit-candidates": false, "recruit-dashboard": false } }
      : e),
    { id: "admin2", loginId: "admin2", pw: "admin2-test-pw", name: "관리자2", role: "admin", active: true, menuPerms: {} },
    { id: "member1", loginId: "member1", pw: "member1-test-pw", name: "일반직원", role: "member", active: true, dept: "영업본부", team: "영업1팀", menuPerms: {} },
    { id: "member2", loginId: "member2", pw: "member2-test-pw", name: "보조면접관", role: "member", active: true, dept: "영업본부", team: "영업1팀", menuPerms: {} },
  ];
  const seed = await api("/save", auth(adminToken, "POST", { _version: initial.version, data: { ...initial.data, employees } }));
  assert.equal(seed.status, 200);

  const restrictedToken = adminToken; // admin1
  const admin2Token = await login(api, "admin2", "admin2-test-pw");
  const memberToken = await login(api, "member1", "member1-test-pw");
  const member2Token = await login(api, "member2", "member2-test-pw");

  const job = await (await api("/api/recruit/jobs", auth(admin2Token, "POST", {
    title: "백엔드 개발자", department: "영업본부",
  }))).json();
  assert.equal(job.ok, true);
  const cand = await (await api("/api/recruit/candidates", auth(admin2Token, "POST", {
    jobId: job.job.id, name: "홍길동",
  }))).json();
  assert.equal(cand.ok, true);

  await t.test("지원자 상세 수정은 오래된 화면의 덮어쓰기를 409로 차단한다", async () => {
    const original = cand.candidate;
    const first = await api(`/api/recruit/candidates/${original.id}`, auth(admin2Token, "POST", {
      memo: "최신 메모", expectedUpdatedAt: original.updatedAt,
    }));
    assert.equal(first.status, 200);
    cand.candidate = (await first.json()).candidate;

    const stale = await api(`/api/recruit/candidates/${original.id}`, auth(admin2Token, "POST", {
      memo: "오래된 탭", expectedUpdatedAt: original.updatedAt,
    }));
    assert.equal(stale.status, 409);
    const body = await stale.json();
    assert.equal(body.conflict, true);
    assert.equal(body.candidate.memo, "최신 메모");
  });

  await t.test("GET .../recruit/candidates/export — recruit-candidates를 개인적으로 꺼둔 admin1은 403, 대조군 admin2는 200(CSV 반환)", async () => {
    const r1 = await api("/api/recruit/candidates/export", { headers: { Authorization: `Bearer ${restrictedToken}` } });
    assert.equal(r1.status, 403);
    const r2 = await api("/api/recruit/candidates/export", { headers: { Authorization: `Bearer ${admin2Token}` } });
    assert.equal(r2.status, 200);
    const body = await r2.json();
    assert.equal(body.ok, true);
    assert.match(body.csv, /홍길동/);
  });

  await t.test("GET .../recruit/dashboard — recruit-dashboard를 개인적으로 꺼둔 admin1은 403, 대조군 admin2는 200", async () => {
    const r1 = await api("/api/recruit/dashboard", { headers: { Authorization: `Bearer ${restrictedToken}` } });
    assert.equal(r1.status, 403);
    const r2 = await api("/api/recruit/dashboard", { headers: { Authorization: `Bearer ${admin2Token}` } });
    assert.equal(r2.status, 200);
    const body = await r2.json();
    assert.equal(body.ok, true);
    assert.ok(body.stats.some(s => s.title === "백엔드 개발자"));
  });

  await t.test("GET .../recruit/jobs, /candidates, /interviews — 이번 증분에서 게이팅하지 않음(부서스코프·면접관열람권으로 이미 안전, 여러 화면이 공유), member도 조회 가능", async () => {
    const r1 = await api("/api/recruit/jobs", { headers: { Authorization: `Bearer ${memberToken}` } });
    assert.equal(r1.status, 200);
    const r2 = await api("/api/recruit/candidates", { headers: { Authorization: `Bearer ${memberToken}` } });
    assert.equal(r2.status, 200);
    const r3 = await api("/api/recruit/interviews", { headers: { Authorization: `Bearer ${memberToken}` } });
    assert.equal(r3.status, 200);
  });

  await t.test("최종 판정은 지정된 심사위원장만 입력하고 허용값만 저장한다", async () => {
    const create = await api("/api/recruit/interviews", auth(admin2Token, "POST", {
      jobId: job.job.id,
      candidateId: cand.candidate.id,
      round: 1,
      interviewerIds: ["member1", "member2"],
      leadInterviewerId: "member1",
      schedule: "2026-08-26T10:00:00+09:00",
    }));
    assert.equal(create.status, 200);
    const interview = (await create.json()).interview;

    const edit = await api(`/api/recruit/interviews/${interview.id}`, auth(admin2Token, "POST", {
      location: "회의실 A", expectedUpdatedAt: interview.updatedAt,
    }));
    assert.equal(edit.status, 200);
    const editedInterview = (await edit.json()).interview;
    const staleEdit = await api(`/api/recruit/interviews/${interview.id}`, auth(admin2Token, "POST", {
      location: "오래된 회의실", expectedUpdatedAt: interview.updatedAt,
    }));
    assert.equal(staleEdit.status, 409);
    assert.equal((await staleEdit.json()).conflict, true);

    const invalid = await api(`/api/recruit/interviews/${interview.id}/verdict`, auth(memberToken, "POST", { verdict: "approve" }));
    assert.equal(invalid.status, 400);

    const nonLead = await api(`/api/recruit/interviews/${interview.id}/verdict`, auth(member2Token, "POST", { verdict: "fail", comment: "우회 시도" }));
    assert.equal(nonLead.status, 403);

    const lead = await api(`/api/recruit/interviews/${interview.id}/verdict`, auth(memberToken, "POST", {
      verdict: "pass", comment: "최종 합격", expectedUpdatedAt: editedInterview.updatedAt,
    }));
    assert.equal(lead.status, 200);
    const leadBody = await lead.json();
    const decided = leadBody.interview.finalVerdict;
    assert.equal(decided.verdict, "pass");
    assert.equal(decided.decidedBy, "member1");

    const stale = await api(`/api/recruit/interviews/${interview.id}/verdict`, auth(memberToken, "POST", {
      verdict: "fail", comment: "오래된 탭", expectedUpdatedAt: editedInterview.updatedAt,
    }));
    assert.equal(stale.status, 409);
    const staleBody = await stale.json();
    assert.equal(staleBody.conflict, true);
    assert.equal(staleBody.interview.finalVerdict.verdict, "pass");

    const noLeadCreate = await api("/api/recruit/interviews", auth(admin2Token, "POST", {
      jobId: job.job.id, candidateId: cand.candidate.id, round: 1,
      interviewerIds: ["member2"], schedule: "2026-08-27T10:00:00+09:00",
    }));
    assert.equal(noLeadCreate.status, 200);
    const noLead = (await noLeadCreate.json()).interview;
    const noLeadVerdict = await api(`/api/recruit/interviews/${noLead.id}/verdict`, auth(member2Token, "POST", { verdict: "hold" }));
    assert.equal(noLeadVerdict.status, 400);
  });
});
