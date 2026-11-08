"use strict";

// 직원 salary/hire 서버 값 검증: 음수·문자열·NaN 급여나 날짜가 아닌 입사일이 /save로 들어와도
// 해당 필드만 저장값으로 되돌려져 급여 계산·근속연수·연차 발생이 깨지지 않아야 한다.
// 관리자 쓰기도 검증 대상이다(role 같은 신원 필드와 달리 값 자체가 문제).
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

test("직원 salary/hire 값 검증", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const api = (path, options) => fetch(server.baseUrl + path, options);
  const boot = await bootstrapAdminAndLogin(server, { loginId: "admin", pw: "admin-test-pw-1", name: "관리자" });
  const admin = boot.token;
  const getData = async () => (await (await api("/data", { headers: { Authorization: `Bearer ${admin}` } })).json());

  const initial = await getData();
  const base = { id: "emp1", loginId: "emp1", pw: "emp1-pw-1234", name: "직원1", role: "member", active: true, dept: "개발본부", team: "A팀", salary: 48000000, hire: "2022-03-01" };
  const seed = await api("/save", auth(admin, "POST", { _version: initial.version, employees: [...initial.data.employees, base] }));
  assert.equal(seed.status, 200);

  let ts = Date.now();
  async function save(patch) {
    const d = await getData();
    ts += 1000;
    const next = d.data.employees.map(e => String(e.id) === "emp1" ? { ...e, ...patch, updatedAt: new Date(ts).toISOString() } : e);
    const r = await api("/save", auth(admin, "POST", { _version: d.version, employees: next }));
    assert.equal(r.status, 200);
    return (await getData()).data.employees.find(e => String(e.id) === "emp1");
  }

  await t.test("정상 salary/hire 변경은 그대로 저장된다", async () => {
    const e = await save({ salary: 52000000, hire: "2022-04-01" });
    assert.equal(e.salary, 52000000);
    assert.equal(e.hire, "2022-04-01");
  });
  await t.test("음수·문자열·무한대 salary는 거부되고 이전 값이 유지된다", async () => {
    for (const bad of [-1, "많이", 1e12]) {
      const e = await save({ salary: bad });
      assert.equal(e.salary, 52000000, `salary=${JSON.stringify(bad)}`);
    }
  });
  await t.test("날짜가 아니거나 존재하지 않는 hire는 거부되고 이전 값이 유지된다", async () => {
    for (const bad of ["아무때나", "2022-13-45", "2022-02-30", 20220401]) {
      const e = await save({ hire: bad });
      assert.equal(e.hire, "2022-04-01", `hire=${JSON.stringify(bad)}`);
    }
  });
  await t.test("구분자·자릿수가 다른 기존 형식(2020.1.2)은 허용되고 값은 변형되지 않는다", async () => {
    const e = await save({ hire: "2020.1.2" });
    assert.equal(e.hire, "2020.1.2");
  });
  await t.test("빈 hire와 salary 0은 미입력으로 허용된다", async () => {
    const e = await save({ hire: "", salary: 0 });
    assert.equal(e.hire, "");
    assert.equal(e.salary, 0);
  });
  await t.test("다른 필드 변경은 salary/hire 검증과 무관하게 반영된다", async () => {
    const e = await save({ salary: -5, phone: "010-0000-0000" });
    assert.equal(e.phone, "010-0000-0000");
    assert.equal(e.salary, 0, "거부된 salary는 직전 저장값(0)으로 유지");
  });
});
