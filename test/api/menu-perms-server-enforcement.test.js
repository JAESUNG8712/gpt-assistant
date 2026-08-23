"use strict";

// menuPerms(권한 관리 화면에서 개인별로 끄는 메뉴)는 지금까지 클라이언트에서만 검사됐다
// (사이드바 숨김 + gotoPage() 가드) — 서버는 전혀 확인하지 않아 브라우저 개발자도구로
// 그 화면이 쓰는 API를 직접 호출하면 그대로 통과됐다(2026-08-21 사용자 지적, 실측 확인).
// requirePage()를 전용 REST API를 가진 화면(회계/PMS/채용/재고/영업/사업계획)에 추가해
// 서버측으로도 강제한 것을 검증한다. 각 테스트는 임시 JSON 파일 + 랜덤 포트의 child
// process만 사용하므로 실제 데이터나 외부 DB를 건드리지 않는다.
const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer, bootstrapAdminAndLogin } = require("../support/start-server");

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

test("menuPerms 서버측 강제(requirePage): 개인별로 끈 메뉴는 role과 무관하게 API 직접 호출도 차단된다", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const api = (path, options) => fetch(server.baseUrl + path, options);

  const boot = await bootstrapAdminAndLogin(server, { loginId: "admin1", pw: "admin1-test-pw", name: "관리자1" });
  const admin1Token = boot.token;
  const initial = await (await api("/data", { headers: { Authorization: `Bearer ${admin1Token}` } })).json();
  const employees = [
    ...initial.data.employees.map(e => e.loginId === "admin1" ? { ...e, menuPerms: { "acct-accounts": false } } : e),
    { id: "admin2", loginId: "admin2", pw: "admin2-test-pw", name: "관리자2", role: "admin", active: true, menuPerms: {} },
    { id: "leader-a", loginId: "leadera", pw: "leader-a-pw", name: "팀장 A", role: "leader", active: true, dept: "영업본부", team: "영업1팀", menuPerms: { "recruit-jobs": false } },
  ];
  const seed = await api("/save", auth(admin1Token, "POST", { _version: initial.version, data: { ...initial.data, employees } }));
  assert.equal(seed.status, 200);

  const admin2Token = await login(api, "admin2", "admin2-test-pw");
  const leaderAToken = await login(api, "leadera", "leader-a-pw");

  await t.test("acct-accounts를 개인적으로 끈 admin은 회계 계정과목 API가 403으로 막힌다(admin이라 role 체크는 통과하는데도)", async () => {
    const r = await api("/api/accounting/accounts/seed-defaults", auth(admin1Token, "POST", {}));
    assert.equal(r.status, 403);
    const body = await r.json();
    assert.equal(body.ok, false);
  });

  await t.test("동일 API를 menuPerms 제한이 없는 다른 admin이 호출하면 정상 처리된다(대조군)", async () => {
    const r = await api("/api/accounting/accounts/seed-defaults", auth(admin2Token, "POST", {}));
    assert.equal(r.status, 200);
  });

  await t.test("acct-accounts 제한은 무관한 다른 화면(PMS)에는 전혀 영향을 주지 않는다", async () => {
    const r = await api("/api/pms/projects", auth(admin1Token, "POST", { name: "테스트 프로젝트" }));
    assert.equal(r.status, 200);
  });

  await t.test("acct-accounts 제한은 회계 데이터 조회(대량 로드, 페이지 단위가 아님)까지 막지는 않는다 — 읽기는 이번 강화 범위 밖", async () => {
    const r = await api("/api/accounting/accounts", { headers: { Authorization: `Bearer ${admin1Token}` } });
    assert.equal(r.status, 200);
  });

  await t.test("recruit-jobs를 끈 leader는 채용공고 생성 API가 403으로 막힌다", async () => {
    const r = await api("/api/recruit/jobs", auth(leaderAToken, "POST", { title: "테스트공고", dept: "영업본부" }));
    assert.equal(r.status, 403);
  });

  await t.test("recruit-jobs 제한은 recruit-candidates(다른 화면)의 지원자 등록 API 자체를 막지는 않는다 — 막히더라도 menuPerms 사유가 아니어야 한다", async () => {
    const jobRes = await api("/api/recruit/jobs", auth(admin2Token, "POST", { title: "정상공고", dept: "영업본부" }));
    assert.equal(jobRes.status, 200);
    const jobId = (await jobRes.json()).job.id;
    const r = await api("/api/recruit/candidates", auth(leaderAToken, "POST", { jobId, name: "지원자A" }));
    const body = await r.json();
    // leaderA가 이 공고의 조회 스코프 밖이면(예: 팀 불일치) 기존의 별개 권한 체크
    // (_recruitCanViewJob)가 403을 낼 수 있다 — 그건 menuPerms 강화와 무관한 정상
    // 동작이므로, "menuPerms 문구가 아니면" 통과로 본다(막혔더라도 그 이유가
    // recruit-jobs 제한 때문이 아니라는 것만 확인).
    assert.notEqual(body.message, "이 메뉴에 대한 접근 권한이 없습니다.");
  });

  await t.test("사업계획(biz-plan) 생성은 acct-accounts 제한과 무관하게 정상 처리된다", async () => {
    const r = await api(
      "/api/budget/business-plan",
      auth(admin1Token, "POST", { name: "T", baseYear: 2026, years: 1, planType: "costOnly" })
    );
    assert.equal(r.status, 200);
  });

  await t.test("budget.html 전용 라우트(DELETE /api/budget/data)는 menuPerms 화면 개념이 없는 별도 화면이라 영향받지 않는다", async () => {
    const r = await api("/api/budget/data", auth(admin1Token, "DELETE"));
    assert.equal(r.status, 200);
  });
});
