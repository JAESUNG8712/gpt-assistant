// 외부 보안 감사(2026-08-19, "fe6ab358 재검토 결과")의 P0 항목 중 P0-1(member→admin
// 권한상승)/P0-2(GET /data를 통한 전사 PII 노출)에 대한 회귀 테스트.
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
  const server = await startServer({ env: { NODE_ENV: "production" } });
  t.after(() => server.stop());

  // 부트스트랩(직원 0명, JSON 파일 모드 예외) — admin 1명 생성.
  let boot = await save(server, null, 0, [
    { id: 1, loginId: "admin", pw: "adminpw123", role: "admin", name: "관리자", dept: "경영지원본부", team: "", active: true },
  ]);
  assert.equal(boot.status, 200, "부트스트랩 실패");
  const adminToken = await login(server, "admin", "adminpw123");
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

  await t.test("P0-1: member가 신규 레코드를 role:admin으로 끼워 넣어도 member로 강제된다", async () => {
    const mem1Token = await login(server, "mem1", "mempw1234");
    const before = await getData(server, mem1Token);
    const injected = [...before.data.employees, {
      id: 999, loginId: "fake-admin", pw: "fakepw1234", role: "admin", name: "가짜관리자", dept: "IT본부", team: "개발팀", active: true,
    }];
    const res = await save(server, mem1Token, before.version, injected);
    assert.equal(res.status, 200);
    const adminCheck = await getData(server, adminToken);
    const fake = adminCheck.data.employees.find(e => String(e.id) === "999");
    // member 스코프로 다시 열람하면 새 레코드 자체가 안 보일 수 있으니 admin 시점에서 확인.
    assert.ok(fake, "신규 레코드 자체는 저장되어야 함(생성 자체를 막는 기능은 아님)");
    assert.equal(fake.role, "member", "신규 레코드도 role은 항상 member로 강제되어야 함");
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

  await t.test("P0-1: 본인 비밀번호 변경(self-service)은 정상 동작한다", async () => {
    // mem3 전용 — 여기서 비밀번호를 바꾸면 이후 테스트들의 mem2 로그인에 영향을 주지
    // 않도록, 다른 검증에서 재사용하지 않는 별도 계정을 쓴다.
    const mem3Token = await login(server, "mem3", "mempw3456");
    const before = await getData(server, mem3Token);
    const selfChange = before.data.employees.map(e =>
      String(e.id) === "5" ? { ...e, pw: "newselfpw1", updatedAt: new Date().toISOString() } : e
    );
    const res = await save(server, mem3Token, before.version, selfChange);
    assert.equal(res.status, 200);
    const relogin = await login(server, "mem3", "newselfpw1");
    assert.ok(relogin, "본인 비밀번호 변경은 정상적으로 반영되어야 함");
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
