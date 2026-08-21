// 외부 보안 감사(2026-08-19, "fe6ab358 재검토 결과")의 P0 항목 중 P0-1(member→admin
// 권한상승)/P0-2(GET /data를 통한 전사 PII 노출)/P0-3(무인증 부트스트랩 선점)/P0-4
// (budget.js 개인별 급여상세 IDOR)/P0-5(퇴직·강등·비번초기화 후에도 기존 토큰이 자연
// 만료까지 유효하던 세션 철회 불가 문제)에 대한 회귀 테스트.
//
// 감사가 명시적으로 지적한 것: 두 취약점은 서로 얽혀 있어 "같은 릴리스에 함께" 고쳐야
// 한다 — PII를 먼저 숨기기만 하고(read-narrowing) employees 쓰기 경로를 그대로 두면,
// 이 앱이 매 저장마다 클라이언트가 가진 전체 employees 배열을 재전송하는 구조이기
// 때문에 non-admin이 받은 "필드가 빠진(salary/birth/address 없는)" 로컬 배열을 다음
// autosave에서 그대로 되돌려보내는 순간, 서버가 그걸 "그 필드를 지우겠다는 요청"으로
// 오인해 다른 직원의 실제 데이터를 지워버릴 수 있다. 이 테스트는 그 결합 시나리오까지
// 함께 검증한다(아래 "read-narrowing 후 그대로 재저장해도 데이터가 지워지지 않는다").
//
// mkdtemp의 DATA_FILE, 랜덤 PORT, child process `node server.js`만 사용 — 실제 DB나
// 운영 데이터 파일은 이 테스트가 존재하는지조차 모른다.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("./support/start-server");
const BOOTSTRAP_SECRET = "test-bootstrap-secret";
const ADMIN_PASSWORD = "adminpw12345";

async function startProductionServer(extraEnv = {}) {
  return startServer({ env: { NODE_ENV: "production", BOOTSTRAP_SECRET, ...extraEnv } });
}

async function bootstrap(server, { loginId = "admin", name = "관리자", pw = ADMIN_PASSWORD } = {}) {
  return fetch(server.baseUrl + "/api/bootstrap/admin", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Bootstrap-Secret": BOOTSTRAP_SECRET },
    body: JSON.stringify({ loginId, name, pw }),
  });
}

async function login(server, loginId, pw) {
  const res = await fetch(server.baseUrl + "/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ loginId, pw }),
  });
  const json = await res.json();
  return json.token;
}

async function getData(server, token) {
  const res = await fetch(server.baseUrl + "/data", { headers: { Authorization: "Bearer " + token } });
  assert.equal(res.status, 200, "GET /data 실패");
  return res.json();
}

async function save(server, token, version, employees) {
  return fetch(server.baseUrl + "/save", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
    body: JSON.stringify({ _version: version, employees }),
  });
}

test("P0-1/P0-2: employees 쓰기 위조 방어 + 읽기 PII 축소(결합 시나리오 포함)", async (t) => {
  const server = await startProductionServer();
  t.after(() => server.stop());

  // 빈 JSON 저장소의 초기 관리자는 무인증 /save가 아닌 전용 one-time endpoint로만 만든다.
  const boot = await bootstrap(server);
  assert.equal(boot.status, 201, "부트스트랩 실패");
  const adminToken = await login(server, "admin", ADMIN_PASSWORD);
  assert.ok(adminToken, "admin 로그인 실패");

  // admin이 leader(팀장A, IT본부/개발팀)와 그 팀원(팀원A, salary/birth/address 있음),
  // 그리고 다른 팀 직원(팀원B)을 추가.
  let d = await getData(server, adminToken);
  let r = await save(server, adminToken, d.version, [
    ...d.data.employees,
    { id: 2, loginId: "lead1", pw: "leadpw123", role: "leader", name: "팀장A", dept: "IT본부", team: "개발팀", salary: 70000000, active: true },
    {
      id: 3, loginId: "mem1", pw: "mempw1234", role: "member", name: "팀원A", dept: "IT본부", team: "개발팀",
      salary: 50000000, birth: "1990-01-01", address: "서울시 강남구", email: "mem1@co.com", phone: "010-1111-2222", active: true,
    },
    { id: 4, loginId: "mem2", pw: "mempw2345", role: "member", name: "팀원B", dept: "IT본부", team: "QA팀", salary: 48000000, birth: "1991-02-02", active: true },
    { id: 5, loginId: "mem3", pw: "mempw3456", role: "member", name: "팀원C", dept: "IT본부", team: "QA팀", active: true },
  ]);
  assert.equal(r.status, 200, "시드 직원 저장 실패");

  await t.test("P0-1: member가 자기 role을 admin으로 고쳐 재전송해도 반영되지 않는다", async () => {
    const mem1Token = await login(server, "mem1", "mempw1234");
    const before = await getData(server, mem1Token);
    const tampered = before.data.employees.map(e =>
      String(e.id) === "3" ? { ...e, role: "admin" } : e
    );
    const res = await save(server, mem1Token, before.version, tampered);
    assert.equal(res.status, 200, "위조 저장 요청 자체는 200으로 받아들여져야 함(부분 되돌림 방식)");
    // 재로그인 토큰이 여전히 member여야 한다 — 이게 실제 exploit이 확인하던 지점.
    const mem1Relogin = await login(server, "mem1", "mempw1234");
    const relogged = await getData(server, mem1Relogin);
    const selfRec = relogged.data.employees.find(e => String(e.id) === "3");
    assert.equal(selfRec.role, "member", "role 위조가 반영되면 안 됨");
  });

  await t.test("P0-1: member가 신규 레코드를 role:admin으로 끼워 넣어도 저장되지 않는다", async () => {
    const mem1Token = await login(server, "mem1", "mempw1234");
    const before = await getData(server, mem1Token);
    const injected = [...before.data.employees, {
      id: 999, loginId: "fake-admin", pw: "fakepw1234", role: "admin", name: "가짜관리자", dept: "IT본부", team: "개발팀", active: true,
    }];
    const res = await save(server, mem1Token, before.version, injected);
    assert.equal(res.status, 200);
    const adminCheck = await getData(server, adminToken);
    const fake = adminCheck.data.employees.find(e => String(e.id) === "999");
    assert.equal(fake, undefined, "일반 사용자가 임의 직원을 생성할 수 있으면 안 됨");
  });

  await t.test("P0-1: 타인 pw를 위조해 재전송해도 원래 비밀번호가 유지된다(계정 탈취 방어)", async () => {
    const mem2Token = await login(server, "mem2", "mempw2345");
    const before = await getData(server, mem2Token);
    const attack = before.data.employees.map(e =>
      String(e.id) === "3" ? { ...e, pw: "hacked000", updatedAt: new Date().toISOString() } : e
    );
    const res = await save(server, mem2Token, before.version, attack);
    assert.equal(res.status, 200);
    const hackedLogin = await login(server, "mem1", "hacked000");
    assert.equal(hackedLogin, undefined, "공격자가 설정한 비밀번호로 로그인되면 안 됨");
    const realLogin = await login(server, "mem1", "mempw1234");
    assert.ok(realLogin, "피해자의 실제 비밀번호는 그대로 유지되어야 함");
  });

  await t.test("P0-1: 본인 비밀번호 변경은 전용 인증 API에서만 정상 동작한다", async () => {
    // mem3 전용 — 여기서 비밀번호를 바꾸면 이후 테스트들의 mem2 로그인에 영향을 주지
    // 않도록, 다른 검증에서 재사용하지 않는 별도 계정을 쓴다.
    const mem3Token = await login(server, "mem3", "mempw3456");
    const res = await fetch(server.baseUrl + "/api/auth/change-password", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + mem3Token },
      body: JSON.stringify({ currentPassword: "mempw3456", newPassword: "newselfpw123" }),
    });
    assert.equal(res.status, 200);
    const relogin = await login(server, "mem3", "newselfpw1");
    assert.equal(relogin, undefined, "짧거나 다른 비밀번호로 로그인되면 안 됨");
    const changedLogin = await login(server, "mem3", "newselfpw123");
    assert.ok(changedLogin, "본인 비밀번호 변경은 정상적으로 반영되어야 함");
  });

  await t.test("P0-2: member는 타인의 salary/birth/address를 볼 수 없다(email/phone은 그대로)", async () => {
    const mem2Token = await login(server, "mem2", "mempw2345");
    const data = await getData(server, mem2Token);
    const mem1AsSeen = data.data.employees.find(e => String(e.id) === "3");
    assert.equal(mem1AsSeen.salary, undefined, "타인 salary가 노출되면 안 됨");
    assert.equal(mem1AsSeen.birth, undefined, "member는 타인 birth를 못 봄(leader/director만 광범위 접근)");
    assert.equal(mem1AsSeen.address, undefined, "타인 address가 노출되면 안 됨");
    assert.equal(mem1AsSeen.email, "mem1@co.com", "email은 사내 전화번호부 성격이라 그대로 노출되어야 함");
    assert.equal(mem1AsSeen.phone, "010-1111-2222", "phone도 마찬가지로 그대로 노출되어야 함");
  });

  await t.test("P0-2: leader는 같은 dept+team 팀원의 salary는 보되 다른 팀 salary는 못 본다", async () => {
    const leadToken = await login(server, "lead1", "leadpw123");
    const data = await getData(server, leadToken);
    const mem1AsSeen = data.data.employees.find(e => String(e.id) === "3"); // 같은 dept+team
    const mem2AsSeen = data.data.employees.find(e => String(e.id) === "4"); // 다른 team
    assert.equal(mem1AsSeen.salary, 50000000, "leader는 같은 팀 salary를 볼 수 있어야 함(사업계획 인건비 자동입력 의존)");
    assert.equal(mem2AsSeen.salary, undefined, "leader는 다른 팀 salary를 보면 안 됨");
    assert.equal(mem1AsSeen.birth, "1990-01-01", "leader는 birth는 팀 무관하게 광범위 접근(대시보드 생일 위젯 의존)");
  });

  await t.test("P0-2: admin은 필터링 없이 전체를 그대로 본다", async () => {
    const data = await getData(server, adminToken);
    const mem1AsSeen = data.data.employees.find(e => String(e.id) === "3");
    assert.equal(mem1AsSeen.salary, 50000000);
    assert.equal(mem1AsSeen.birth, "1990-01-01");
    assert.equal(mem1AsSeen.address, "서울시 강남구");
  });

  await t.test("결합 시나리오: PII가 축소된 로컬 상태를 그대로 재저장해도 다른 필드가 지워지지 않는다", async () => {
    // mem2가 GET /data로 받은(salary/birth/address가 이미 빠진) 자기 로컬 employees 배열을,
    // 아무것도 바꾸지 않고 그대로 재전송하는 흔한 자동저장 패턴을 재현한다. P0-1 쓰기 가드가
    // 없었다면 이 저장이 mem1의 salary/birth/address 필드를 "빈 값으로" 덮어썼을 것이다
    // (감사가 "P0-1/P0-2는 함께 배포해야 한다"고 지적한 바로 그 상호작용).
    const mem2Token = await login(server, "mem2", "mempw2345");
    const filtered = await getData(server, mem2Token);
    const mem1Filtered = filtered.data.employees.find(e => String(e.id) === "3");
    assert.equal(mem1Filtered.salary, undefined, "전제 확인: mem2가 받은 로컬 상태엔 mem1.salary가 없어야 함");

    const res = await save(server, mem2Token, filtered.version, filtered.data.employees);
    assert.equal(res.status, 200);

    const adminRecheck = await getData(server, adminToken);
    const mem1AfterRoundtrip = adminRecheck.data.employees.find(e => String(e.id) === "3");
    assert.equal(mem1AfterRoundtrip.salary, 50000000, "mem2가 필드 없는 로컬 상태를 그대로 재저장해도 mem1의 salary가 지워지면 안 됨");
    assert.equal(mem1AfterRoundtrip.birth, "1990-01-01", "마찬가지로 birth도 지워지면 안 됨");
    assert.equal(mem1AfterRoundtrip.address, "서울시 강남구", "마찬가지로 address도 지워지면 안 됨");
  });
});

test("P0-4: budget.js emp-pay-plan/by-ids가 스코프 밖 id를 조용히 거른다(IDOR 방어)", async (t) => {
  const server = await startProductionServer();
  t.after(() => server.stop());

  const boot = await bootstrap(server);
  assert.equal(boot.status, 201);
  const adminToken = await login(server, "admin", ADMIN_PASSWORD);

  let d = await getData(server, adminToken);
  let r = await save(server, adminToken, d.version, [
    ...d.data.employees,
    { id: 2, loginId: "mem1", pw: "mempw1234", role: "member", name: "팀원A", dept: "IT본부", team: "개발팀", active: true },
    { id: 3, loginId: "boss", pw: "bosspw123", role: "director", name: "임원A", dept: "경영지원본부", team: "", active: true, salary: 200000000 },
    { id: 4, loginId: "dir1", pw: "dirpw1234", role: "director", name: "본부장B", dept: "경영지원본부", team: "", active: true },
    { id: 5, loginId: "lead1", pw: "leadpw123", role: "leader", name: "팀장C", dept: "경영지원본부", team: "인사팀", active: true },
  ]);
  assert.equal(r.status, 200, "시드 직원 저장 실패");

  r = await fetch(server.baseUrl + "/api/budget/emp-pay-plan", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + adminToken },
    body: JSON.stringify({ empId: 3, year: 2027, items: [{ category: "급여", name: "RSU 지급", amount: 12000000 }] }),
  });
  assert.equal(r.status, 200, "개인별 급여상세 시드 실패");

  await t.test("member는 다른 부서 직원의 급여상세를 by-ids로 열람할 수 없다", async () => {
    const mem1Token = await login(server, "mem1", "mempw1234");
    const res = await fetch(server.baseUrl + "/api/budget/emp-pay-plan/by-ids?year=2027&ids=3", {
      headers: { Authorization: "Bearer " + mem1Token },
    });
    const json = await res.json();
    assert.equal(res.status, 200);
    assert.deepEqual(json.plans, [], "스코프 밖 id는 조용히 걸러져 빈 배열이어야 함");
  });

  await t.test("director는 같은 dept(team-less) 인원의 급여상세를 볼 수 있다", async () => {
    const dir1Token = await login(server, "dir1", "dirpw1234");
    const res = await fetch(server.baseUrl + "/api/budget/emp-pay-plan/by-ids?year=2027&ids=3", {
      headers: { Authorization: "Bearer " + dir1Token },
    });
    const json = await res.json();
    assert.equal(json.plans.length, 1, "같은 dept 소속이면 director는 열람 가능해야 함");
  });

  await t.test("leader는 같은 dept라도 다른 team이면 볼 수 없다(dept+team 스코프)", async () => {
    const lead1Token = await login(server, "lead1", "leadpw123");
    const res = await fetch(server.baseUrl + "/api/budget/emp-pay-plan/by-ids?year=2027&ids=3", {
      headers: { Authorization: "Bearer " + lead1Token },
    });
    const json = await res.json();
    assert.deepEqual(json.plans, [], "team이 다르면 leader는 열람 불가여야 함");
  });

  await t.test("admin은 스코프 제한 없이 전체를 본다", async () => {
    const res = await fetch(server.baseUrl + "/api/budget/emp-pay-plan/by-ids?year=2027&ids=3", {
      headers: { Authorization: "Bearer " + adminToken },
    });
    const json = await res.json();
    assert.equal(json.plans.length, 1);
    assert.equal(json.plans[0].items[0].amount, 12000000);
  });
});

test("P0-3: 전용 부트스트랩은 시크릿·입력 검증·1회성 조건을 모두 강제한다", async (t) => {
  await t.test("무인증 /save는 빈 저장소여도 401", async (t2) => {
    const server = await startProductionServer();
    t2.after(() => server.stop());
    const res = await save(server, null, 0, [{ id: 1, loginId: "attacker", pw: "attackerpw123", role: "admin", name: "공격자", active: true }]);
    assert.equal(res.status, 401);
  });

  await t.test("시크릿 누락/오류는 401, 올바른 시크릿만 201", async (t2) => {
    const server = await startProductionServer();
    t2.after(() => server.stop());
    const missing = await fetch(server.baseUrl + "/api/bootstrap/admin", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ loginId: "admin", name: "관리자", pw: ADMIN_PASSWORD }),
    });
    assert.equal(missing.status, 401);
    const wrong = await fetch(server.baseUrl + "/api/bootstrap/admin", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Bootstrap-Secret": "wrong" },
      body: JSON.stringify({ loginId: "admin", name: "관리자", pw: ADMIN_PASSWORD }),
    });
    assert.equal(wrong.status, 401);
    const ok = await bootstrap(server);
    assert.equal(ok.status, 201);
  });

  await t.test("BOOTSTRAP_SECRET이 없으면 fail-closed(503)이며, 성공 뒤 재실행은 409", async (t2) => {
    const missingSecret = await startServer({ env: { NODE_ENV: "production", BOOTSTRAP_SECRET: "" } });
    t2.after(() => missingSecret.stop());
    const unavailable = await fetch(missingSecret.baseUrl + "/api/bootstrap/admin", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ loginId: "admin", name: "관리자", pw: ADMIN_PASSWORD }),
    });
    assert.equal(unavailable.status, 503);

    const server = await startProductionServer();
    t2.after(() => server.stop());
    assert.equal((await bootstrap(server)).status, 201);
    const again = await bootstrap(server, { loginId: "otheradmin", name: "다른 관리자" });
    assert.equal(again.status, 409);
  });
});

test("P0-5: 퇴직/강등/비밀번호 초기화 후 기존 토큰이 즉시 무효화된다(authVersion 세션 철회)", async (t) => {
  const server = await startProductionServer();
  t.after(() => server.stop());

  const boot = await bootstrap(server);
  assert.equal(boot.status, 201);
  const adminToken = await login(server, "admin", ADMIN_PASSWORD);

  let d = await getData(server, adminToken);
  let r = await save(server, adminToken, d.version, [
    ...d.data.employees,
    { id: 2, loginId: "victim", pw: "victimpw12", role: "member", name: "피해자", active: true },
    { id: 3, loginId: "demoted", pw: "demotedpw1", role: "leader", name: "강등대상", active: true },
    { id: 4, loginId: "pwreset", pw: "oldpw12345", role: "member", name: "비번초기화대상", active: true },
  ]);
  assert.equal(r.status, 200, "시드 실패");

  await t.test("퇴직 처리(active:false) 후 기존 토큰은 즉시 401", async () => {
    const victimToken = await login(server, "victim", "victimpw12");
    await getData(server, victimToken); // 내부에서 200 단언(퇴직 전에는 정상 동작해야 함)

    const before = await getData(server, adminToken);
    r = await save(server, adminToken, before.version, before.data.employees.map(e =>
      String(e.id) === "2" ? { ...e, active: false, updatedAt: new Date().toISOString() } : e
    ));
    assert.equal(r.status, 200);

    const res = await fetch(server.baseUrl + "/data", { headers: { Authorization: "Bearer " + victimToken } });
    assert.equal(res.status, 401, "퇴직 처리 직후 기존 토큰은 자연 만료를 기다리지 않고 즉시 무효화되어야 함");
  });

  await t.test("강등(role 하향) 후 기존 토큰은 즉시 401, 재로그인은 정상 동작", async () => {
    const demotedToken = await login(server, "demoted", "demotedpw1");
    await getData(server, demotedToken); // 내부에서 200 단언

    const before = await getData(server, adminToken);
    r = await save(server, adminToken, before.version, before.data.employees.map(e =>
      String(e.id) === "3" ? { ...e, role: "member", updatedAt: new Date().toISOString() } : e
    ));
    assert.equal(r.status, 200);

    let res = await fetch(server.baseUrl + "/data", { headers: { Authorization: "Bearer " + demotedToken } });
    assert.equal(res.status, 401, "강등 직후 기존(leader 권한) 토큰은 즉시 무효화되어야 함");

    const relogin = await login(server, "demoted", "demotedpw1");
    assert.ok(relogin, "비밀번호가 그대로면 재로그인은 정상 동작해야 함(새 role로 재발급)");
    await getData(server, relogin); // 내부에서 200 단언
  });

  await t.test("관리자의 비밀번호 강제 초기화 후 기존 토큰은 즉시 401", async () => {
    const pwresetToken = await login(server, "pwreset", "oldpw12345");
    await getData(server, pwresetToken); // 내부에서 200 단언

    const before = await getData(server, adminToken);
    r = await save(server, adminToken, before.version, before.data.employees.map(e =>
      String(e.id) === "4" ? { ...e, pw: "newpw67890", updatedAt: new Date().toISOString() } : e
    ));
    assert.equal(r.status, 200);

    const res = await fetch(server.baseUrl + "/data", { headers: { Authorization: "Bearer " + pwresetToken } });
    assert.equal(res.status, 401, "관리자 강제 비번초기화 직후 기존 토큰은 즉시 무효화되어야 함");
  });

  await t.test("역할/비밀번호/재직여부와 무관한 변경은 기존 토큰을 무효화하지 않는다", async () => {
    const stableToken = await login(server, "admin", ADMIN_PASSWORD);
    const before = await getData(server, adminToken);
    r = await save(server, adminToken, before.version, before.data.employees.map(e =>
      String(e.id) === "1" ? { ...e, phone: "010-0000-0000", updatedAt: new Date().toISOString() } : e
    ));
    assert.equal(r.status, 200);

    const res = await fetch(server.baseUrl + "/data", { headers: { Authorization: "Bearer " + stableToken } });
    assert.equal(res.status, 200, "role/pw/active와 무관한 변경으로 토큰이 무효화되면 안 됨");
  });
});
