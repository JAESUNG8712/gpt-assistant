"use strict";

// 연말정산(간이) 결과(yearEndSettlements) — payslips와 동일한 민감도·동일한 패턴(admin만
// 계산/확정, 그 외 역할은 본인 것만 조회)으로 서버에 배선했다(2026-09-09). 실제 세액 계산
// 공식(_yesIncomeDeduction/_yesTaxByBase/_yesEarnedIncomeCredit)은 클라이언트(public/index.html)
// 순수 함수라 이 서버 테스트로는 검증할 수 없다 — 이 파일은 서버가 담당하는 부분만 검증한다:
// role 게이팅(admin만 쓰기)·menuPerms 개인별 게이팅·본인만 조회되는 필터·값 검증(dependents/
// year 범위)·필터링된(불완전한) 로컬 배열 재저장 시 타인 레코드가 지워지지 않는 protected-merge.
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
function makeSettlement(empId, year, overrides) {
  return {
    id: `yes-${empId}-${year}`, empId, year, dependents: 1,
    grossPay: 60000000, incomeDeduction: 12000000, earnedIncomeAmount: 48000000,
    personalDeduction: 3000000, taxBase: 45000000, calculatedTax: 5490000, taxCredit: 500000,
    finalTax: 4990000, finalLocalTax: 499000, paidTax: 9000000, paidLocalTax: 900000,
    diffTax: 4010000, diffLocalTax: 401000, confirmed: false, confirmedAt: null,
    calculatedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

test("연말정산(간이) — role 게이팅·menuPerms·본인조회 필터·값 검증·protected-merge", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const api = (path, options) => fetch(server.baseUrl + path, options);

  const boot = await bootstrapAdminAndLogin(server, { loginId: "admin1", pw: "admin1-test-pw", name: "관리자1" });
  const adminToken = boot.token;
  const initial = await getData(api, adminToken);

  const employees = [
    ...initial.data.employees,
    { id: "dir1", loginId: "dir1", pw: "dir1-test-pw", name: "사업부장", role: "director", active: true, dept: "개발본부", menuPerms: {} },
    { id: "mem1", loginId: "mem1", pw: "mem1-test-pw", name: "팀원1", role: "member", active: true, dept: "개발본부", team: "A팀", menuPerms: {} },
    { id: "mem2", loginId: "mem2", pw: "mem2-test-pw", name: "팀원2", role: "member", active: true, dept: "영업본부", team: "B팀", menuPerms: {} },
  ];
  const seed = await api("/save", auth(adminToken, "POST", { _version: initial.version, employees }));
  assert.equal(seed.status, 200);

  const dir1Token = await login(api, "dir1", "dir1-test-pw");
  const mem1Token = await login(api, "mem1", "mem1-test-pw");
  const mem2Token = await login(api, "mem2", "mem2-test-pw");

  await t.test("director/member는 새 정산 레코드를 만들 수 없다(admin 전용, 저장본으로 되돌려짐)", async () => {
    const d = await getData(api, dir1Token);
    const r = await api("/save", auth(dir1Token, "POST", {
      _version: d.version,
      yearEndSettlements: [makeSettlement("dir1", 2025)],
    }));
    assert.equal(r.status, 200); // 요청 자체는 성공하되, 레코드만 조용히 드롭된다
    const check = await getData(api, adminToken);
    assert.equal((check.data.yearEndSettlements || []).length, 0);
  });

  await t.test("admin은 정산 레코드를 만들 수 있다", async () => {
    const d = await getData(api, adminToken);
    const r = await api("/save", auth(adminToken, "POST", {
      _version: d.version,
      yearEndSettlements: [makeSettlement("mem1", 2025), makeSettlement("mem2", 2025, { dependents: 0 })],
    }));
    assert.equal(r.status, 200);
    const check = await getData(api, adminToken);
    assert.equal(check.data.yearEndSettlements.length, 2);
  });

  await t.test("본인 것만 조회된다(GET /data 필터) — mem1은 mem2 레코드를 볼 수 없다", async () => {
    const d = await getData(api, mem1Token);
    assert.equal(d.data.yearEndSettlements.length, 1);
    assert.equal(d.data.yearEndSettlements[0].empId, "mem1");
  });

  await t.test("director도 admin이 아니므로 본인 것만 조회된다(dir1은 아직 레코드 없음)", async () => {
    const d = await getData(api, dir1Token);
    assert.equal((d.data.yearEndSettlements || []).length, 0);
  });

  await t.test("mem1이 필터링된(불완전한) 로컬 배열을 그대로 재저장해도 mem2 레코드는 지워지지 않는다(protected-merge)", async () => {
    const d = await getData(api, mem1Token);
    assert.equal(d.data.yearEndSettlements.length, 1); // mem1 것만
    const r = await api("/save", auth(mem1Token, "POST", {
      _version: d.version,
      yearEndSettlements: d.data.yearEndSettlements, // 그대로 재전송(변경 없음)
    }));
    assert.equal(r.status, 200);
    const check = await getData(api, adminToken);
    assert.equal(check.data.yearEndSettlements.length, 2, "mem2 레코드가 지워지면 안 된다");
  });

  await t.test("dependents가 범위를 벗어나면(음수/21 이상/비정수) 저장본으로 되돌려진다", async () => {
    const d = await getData(api, adminToken);
    const bad = d.data.yearEndSettlements.map(y => y.empId === "mem1" ? { ...y, dependents: -1, updatedAt: new Date().toISOString() } : y);
    const r1 = await api("/save", auth(adminToken, "POST", { _version: d.version, yearEndSettlements: bad }));
    assert.equal(r1.status, 200);
    const check1 = await getData(api, adminToken);
    const mem1After1 = check1.data.yearEndSettlements.find(y => y.empId === "mem1");
    assert.equal(mem1After1.dependents, 1, "음수 dependents는 반영되면 안 된다");

    const d2 = await getData(api, adminToken);
    const bad2 = d2.data.yearEndSettlements.map(y => y.empId === "mem1" ? { ...y, dependents: 21, updatedAt: new Date().toISOString() } : y);
    const r2 = await api("/save", auth(adminToken, "POST", { _version: d2.version, yearEndSettlements: bad2 }));
    assert.equal(r2.status, 200);
    const check2 = await getData(api, adminToken);
    const mem1After2 = check2.data.yearEndSettlements.find(y => y.empId === "mem1");
    assert.equal(mem1After2.dependents, 1, "21 이상 dependents는 반영되면 안 된다");
  });

  await t.test("year가 비정상이면(문자열·범위 밖) 신규 레코드가 드롭된다", async () => {
    const d = await getData(api, adminToken);
    const withBadYear = [...d.data.yearEndSettlements, makeSettlement("dir1", 1900)];
    const r = await api("/save", auth(adminToken, "POST", { _version: d.version, yearEndSettlements: withBadYear }));
    assert.equal(r.status, 200);
    const check = await getData(api, adminToken);
    assert.equal(check.data.yearEndSettlements.length, 2, "비정상 year 레코드는 추가되면 안 된다");
  });

  await t.test("정상 dependents 수정(admin)은 그대로 반영된다", async () => {
    const d = await getData(api, adminToken);
    const good = d.data.yearEndSettlements.map(y => y.empId === "mem1" ? { ...y, dependents: 3, updatedAt: new Date().toISOString() } : y);
    const r = await api("/save", auth(adminToken, "POST", { _version: d.version, yearEndSettlements: good }));
    assert.equal(r.status, 200);
    const check = await getData(api, adminToken);
    assert.equal(check.data.yearEndSettlements.find(y => y.empId === "mem1").dependents, 3);
  });

  await t.test("개인적으로 yearend-settlement 메뉴를 끈 admin은 쓰기가 저장본으로 되돌려진다(menuPerms 게이팅)", async () => {
    const cur = await getData(api, adminToken);
    const withMenuOff = cur.data.employees.map(e => e.loginId === "admin1" ? { ...e, menuPerms: { "yearend-settlement": false } } : e);
    const s = await api("/save", auth(adminToken, "POST", { _version: cur.version, employees: withMenuOff }));
    assert.equal(s.status, 200);

    const d = await getData(api, adminToken);
    const attempt = d.data.yearEndSettlements.map(y => y.empId === "mem2" ? { ...y, dependents: 5, updatedAt: new Date().toISOString() } : y);
    const r = await api("/save", auth(adminToken, "POST", { _version: d.version, yearEndSettlements: attempt }));
    assert.equal(r.status, 200);
    const check = await getData(api, adminToken);
    assert.equal(check.data.yearEndSettlements.find(y => y.empId === "mem2").dependents, 0, "메뉴가 꺼진 admin의 변경은 반영되면 안 된다");
  });
});
