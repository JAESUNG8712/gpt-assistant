"use strict";

// 작업2(항목E): 채용 소스추적(source 필드) + 지원자→직원 전환(/convert, 반자동).
// source는 memo 등 다른 지원자 필드와 동일하게 서버가 엄격한 enum 검증을 하지 않고
// 50자로만 길이를 제한한다(클라이언트는 고정 select를 쓰지만 서버 API를 직접 호출해도
// 저장 자체가 거부되진 않음 — 이 코드베이스의 다른 자유텍스트 필드들과 동일한 관례).
//
// 전환(/convert)은 employees(전체상태 /save 블롭)에 이미 만들어진 직원 id를 받아
// recruit_candidates(전용 REST 테이블)에 역참조만 남기는 두 번째 단계다 — 직원
// 레코드 자체를 만들지 않는다(그건 /save의 책임). admin 전용으로 제한한 이유는
// "신규 직원 등록"(hr-register) 페이지 자체가 이미 admin 전용이기 때문.
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

async function login(api, loginId, pw) {
  const r = await (await api("/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ loginId, pw }),
  })).json();
  assert.equal(r.ok, true, `${loginId} 로그인 실패: ${JSON.stringify(r)}`);
  return r.token;
}

test("채용 소스추적 + 지원자→직원 전환", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const api = (path, options) => fetch(server.baseUrl + path, options);

  const boot = await bootstrapAdminAndLogin(server, { loginId: "admin1", pw: "admin1-test-pw", name: "관리자1" });
  const adminToken = boot.token;

  // director 계정 하나(소속 부서 일치, 전환 권한은 admin 전용이라 403이 돼야 함)도 함께 심어둔다.
  const initial = await (await api("/data", { headers: { Authorization: `Bearer ${adminToken}` } })).json();
  const employees = [
    ...initial.data.employees,
    { id: "director1", loginId: "director1", pw: "director1-test-pw", name: "사업부장", role: "director", active: true, dept: "영업본부", team: "", menuPerms: {} },
  ];
  const seed = await api("/save", auth(adminToken, "POST", { _version: initial.version, data: { ...initial.data, employees } }));
  assert.equal(seed.status, 200);
  const directorToken = await login(api, "director1", "director1-test-pw");

  const job = await (await api("/api/recruit/jobs", auth(adminToken, "POST", {
    title: "백엔드 개발자", department: "영업본부", stages: ["서류전형", "1차면접", "최종합격"],
  }))).json();
  assert.equal(job.ok, true);

  await t.test("지원자 등록 시 source가 저장되고, 미지정이면 빈 문자열, 50자를 넘으면 잘린다", async () => {
    const c1 = await (await api("/api/recruit/candidates", auth(adminToken, "POST", {
      jobId: job.job.id, name: "홍길동", source: "채용사이트",
    }))).json();
    assert.equal(c1.ok, true);
    assert.equal(c1.candidate.source, "채용사이트");
    assert.equal(c1.candidate.employeeId, null);

    const c2 = await (await api("/api/recruit/candidates", auth(adminToken, "POST", {
      jobId: job.job.id, name: "김철수",
    }))).json();
    assert.equal(c2.ok, true);
    assert.equal(c2.candidate.source, "");

    const longSource = "가".repeat(80);
    const c3 = await (await api("/api/recruit/candidates", auth(adminToken, "POST", {
      jobId: job.job.id, name: "이영희", source: longSource,
    }))).json();
    assert.equal(c3.ok, true);
    assert.equal(c3.candidate.source.length, 50);
  });

  await t.test("지원자 수정 시 source를 변경할 수 있다", async () => {
    const list = await (await api("/api/recruit/candidates", { headers: { Authorization: `Bearer ${adminToken}` } })).json();
    const hong = list.candidates.find(c => c.name === "홍길동");
    const edited = await (await api(`/api/recruit/candidates/${hong.id}`, auth(adminToken, "POST", {
      source: "헤드헌터", expectedUpdatedAt: hong.updatedAt,
    }))).json();
    assert.equal(edited.ok, true);
    assert.equal(edited.candidate.source, "헤드헌터");
  });

  await t.test("CSV 내보내기에 '지원 경로' 열이 포함된다", async () => {
    const r = await (await api("/api/recruit/candidates/export", { headers: { Authorization: `Bearer ${adminToken}` } })).json();
    assert.equal(r.ok, true);
    assert.match(r.csv, /지원 경로/);
    assert.match(r.csv, /헤드헌터/);
  });

  await t.test("대시보드에 지원 경로별(bySource) 집계가 포함된다", async () => {
    const r = await (await api("/api/recruit/dashboard", { headers: { Authorization: `Bearer ${adminToken}` } })).json();
    assert.equal(r.ok, true);
    assert.ok(Array.isArray(r.bySource));
    const headhunter = r.bySource.find(x => x.source === "헤드헌터");
    assert.ok(headhunter, `bySource에 헤드헌터가 없음: ${JSON.stringify(r.bySource)}`);
    assert.equal(headhunter.count, 1);
    // source 미지정("김철수")은 "미입력"으로 집계된다.
    const unspecified = r.bySource.find(x => x.source === "미입력");
    assert.ok(unspecified, `bySource에 미입력이 없음: ${JSON.stringify(r.bySource)}`);
  });

  let kimCandidateId, kimEmployeeId;

  await t.test("최종합격 전에는 전환할 수 없다(409)", async () => {
    const list = await (await api("/api/recruit/candidates", { headers: { Authorization: `Bearer ${adminToken}` } })).json();
    const kim = list.candidates.find(c => c.name === "김철수");
    kimCandidateId = kim.id;
    const r = await api(`/api/recruit/candidates/${kim.id}/convert`, auth(adminToken, "POST", { employeeId: "director1" }));
    assert.equal(r.status, 409);
  });

  await t.test("employeeId 누락은 400", async () => {
    // 먼저 최종합격으로 전환해 둔다.
    const bump = await (await api(`/api/recruit/candidates/${kimCandidateId}/status`, auth(adminToken, "POST", { status: "최종합격" }))).json();
    assert.equal(bump.ok, true);
    const r = await api(`/api/recruit/candidates/${kimCandidateId}/convert`, auth(adminToken, "POST", {}));
    assert.equal(r.status, 400);
  });

  await t.test("존재하지 않는 employeeId는 404", async () => {
    const r = await api(`/api/recruit/candidates/${kimCandidateId}/convert`, auth(adminToken, "POST", { employeeId: "no-such-employee-id" }));
    assert.equal(r.status, 404);
  });

  await t.test("admin이 아닌 director는 전환 권한이 없다(403) — 신규 직원 등록 자체가 admin 전용인 것과 동일 기준", async () => {
    const r = await api(`/api/recruit/candidates/${kimCandidateId}/convert`, auth(directorToken, "POST", { employeeId: "director1" }));
    assert.equal(r.status, 403);
  });

  await t.test("정상 전환: 상태가 '입사'로, employeeId·convertedAt이 기록된다", async () => {
    kimEmployeeId = "director1"; // 이미 존재하는 직원 id를 그대로 재사용(employeeId 검증 대상만 확인)
    const r = await api(`/api/recruit/candidates/${kimCandidateId}/convert`, auth(adminToken, "POST", { employeeId: kimEmployeeId }));
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);
    assert.equal(body.candidate.status, "입사");
    assert.equal(body.candidate.employeeId, kimEmployeeId);
    assert.ok(body.candidate.convertedAt);

    // 재조회로도 동일하게 확인 — 대시보드의 "활성 지원자" 집계(불합격/최종합격/입사/마감
    // 제외)에서도 이 지원자가 더 이상 "진행중"으로 집계되지 않음을 간접 확인.
    const list = await (await api("/api/recruit/candidates", { headers: { Authorization: `Bearer ${adminToken}` } })).json();
    const kim = list.candidates.find(c => c.id === kimCandidateId);
    assert.equal(kim.status, "입사");
    assert.equal(kim.employeeId, kimEmployeeId);
  });

  await t.test("중복 전환 차단: 이미 전환된 지원자는 다시 전환할 수 없다(409)", async () => {
    const r = await api(`/api/recruit/candidates/${kimCandidateId}/convert`, auth(adminToken, "POST", { employeeId: kimEmployeeId }));
    assert.equal(r.status, 409);
    const body = await r.json();
    assert.match(body.message, /이미/);
  });

  await t.test("recruit-candidates 메뉴를 개인적으로 꺼둔 admin은 전환 API도 403", async () => {
    const data2 = await (await api("/data", { headers: { Authorization: `Bearer ${adminToken}` } })).json();
    const restricted = data2.data.employees.map(e => e.loginId === "admin1" ? { ...e, menuPerms: { "recruit-candidates": false } } : e);
    const seed2 = await api("/save", auth(adminToken, "POST", { _version: data2.version, data: { ...data2.data, employees: restricted } }));
    assert.equal(seed2.status, 200);

    // requirePage("recruit-candidates")가 requireRole 다음, 지원자 조회보다 먼저
    // 실행되므로 존재하지 않는 id로도 403이 먼저 응답된다.
    const r = await api(`/api/recruit/candidates/${kimCandidateId}/convert`, auth(adminToken, "POST", { employeeId: kimEmployeeId }));
    assert.equal(r.status, 403);
  });
});
