"use strict";

// 채용 합격/불합격 결과 통보 기능 — 이 앱에는 SMTP(이메일 발송)가 없어 서버가
// 지원자에게 직접 메일을 보낼 수 없다(전체 코드에 nodemailer/SMTP 참조 0건,
// 2026-09-09 세션에서 확인). 대신 발급 이력만 서버에 남기고(POST .../notice),
// 실제 통보서는 클라이언트가 인쇄 가능한 문서로 생성해 담당자가 인쇄·수기 전달
// 하거나 내용을 복사해 별도 메일로 보내는 방식(인사발령장 printHRLetter()와
// 동일한 패턴) — 이 테스트는 서버 측 이력 기록·권한·입력 검증만 검증한다.
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
  const response = await api("/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ loginId, pw }),
  });
  const body = await response.json();
  assert.equal(body.ok, true, `${loginId} 로그인 실패`);
  return body.token;
}

test("채용: 합격/불합격 통보서 발급 이력 — 권한·스코프·입력 검증", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const api = (path, options) => fetch(server.baseUrl + path, options);

  const boot = await bootstrapAdminAndLogin(server, { loginId: "admin1", pw: "admin1-test-pw", name: "관리자1" });
  const adminToken = boot.token;

  const initial = await (await api("/data", { headers: { Authorization: `Bearer ${adminToken}` } })).json();
  const employees = [
    ...initial.data.employees,
    { id: "dir_sales", loginId: "dir_sales", pw: "dir-sales-pw", name: "영업본부장", role: "director", active: true, dept: "영업본부", team: "", menuPerms: {} },
    { id: "dir_dev", loginId: "dir_dev", pw: "dir-dev-pw", name: "개발본부장", role: "director", active: true, dept: "개발본부", team: "", menuPerms: {} },
    { id: "member1", loginId: "member1", pw: "member1-test-pw", name: "일반직원", role: "member", active: true, dept: "영업본부", team: "영업1팀", menuPerms: {} },
  ];
  const seed = await api("/save", auth(adminToken, "POST", { _version: initial.version, data: { ...initial.data, employees } }));
  assert.equal(seed.status, 200);

  const dirSalesToken = await login(api, "dir_sales", "dir-sales-pw");
  const dirDevToken = await login(api, "dir_dev", "dir-dev-pw");
  const memberToken = await login(api, "member1", "member1-test-pw");

  const job = await (await api("/api/recruit/jobs", auth(dirSalesToken, "POST", {
    title: "영업 담당자", department: "영업본부",
  }))).json();
  assert.equal(job.ok, true);
  const cand = await (await api("/api/recruit/candidates", auth(dirSalesToken, "POST", {
    jobId: job.job.id, name: "홍길동",
  }))).json();
  assert.equal(cand.ok, true);
  const candId = cand.candidate.id;

  await t.test("member 역할은 requireRole에서 즉시 403", async () => {
    const r = await api(`/api/recruit/candidates/${candId}/notice`, auth(memberToken, "POST", { result: "pass", message: "합격 안내" }));
    assert.equal(r.status, 403);
  });

  await t.test("무관 부서 director는 후보를 볼 수 없어 403", async () => {
    const r = await api(`/api/recruit/candidates/${candId}/notice`, auth(dirDevToken, "POST", { result: "pass", message: "합격 안내" }));
    assert.equal(r.status, 403);
  });

  await t.test("result 값이 pass/fail이 아니면 400", async () => {
    const r = await api(`/api/recruit/candidates/${candId}/notice`, auth(dirSalesToken, "POST", { result: "maybe", message: "?" }));
    assert.equal(r.status, 400);
  });

  await t.test("같은 부서 director는 정상 발급 — noticeHistory에 기록", async () => {
    const r = await api(`/api/recruit/candidates/${candId}/notice`, auth(dirSalesToken, "POST", { result: "pass", message: "최종 합격을 축하드립니다." }));
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);
    assert.equal(body.candidate.noticeHistory.length, 1);
    assert.equal(body.candidate.noticeHistory[0].result, "pass");
    assert.equal(body.candidate.noticeHistory[0].message, "최종 합격을 축하드립니다.");
    assert.equal(body.candidate.noticeHistory[0].issuedBy, "dir_sales");
  });

  await t.test("재발급 시 이력이 누적되고(덮어쓰지 않음), 조회에도 반영된다", async () => {
    const r = await api(`/api/recruit/candidates/${candId}/notice`, auth(dirSalesToken, "POST", { result: "fail", message: "재검토 후 불합격 처리." }));
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.candidate.noticeHistory.length, 2);
    assert.equal(body.candidate.noticeHistory[1].result, "fail");

    const fetched = await (await api(`/api/recruit/candidates/${candId}`, { headers: { Authorization: `Bearer ${dirSalesToken}` } })).json();
    assert.equal(fetched.ok, true);
    assert.equal(fetched.candidate.noticeHistory.length, 2);
  });

  await t.test("개인적으로 recruit-candidates 메뉴를 끈 admin은 403 (menuPerms 게이팅)", async () => {
    const cur = await (await api("/data", { headers: { Authorization: `Bearer ${adminToken}` } })).json();
    const withMenuOff = cur.data.employees.map(e => e.loginId === "admin1" ? { ...e, menuPerms: { "recruit-candidates": false } } : e);
    const s = await api("/save", auth(adminToken, "POST", { _version: cur.version, data: { ...cur.data, employees: withMenuOff } }));
    assert.equal(s.status, 200);

    const r = await api(`/api/recruit/candidates/${candId}/notice`, auth(adminToken, "POST", { result: "pass", message: "재확인" }));
    assert.equal(r.status, 403);
  });

  await t.test("토큰 없이 호출하면 401", async () => {
    const r = await api(`/api/recruit/candidates/${candId}/notice`, auth(null, "POST", { result: "pass", message: "x" }));
    assert.equal(r.status, 401);
  });
});
