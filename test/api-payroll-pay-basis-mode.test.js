// settings.payBasisMode("annual"|"step")/settings.salaryStepTable({직급:[호봉별 월 기본급,...]})
// — 직급×직급연차 기준 급여 지급방식(호봉제, D4 라운드)을 정하는 설정값. 이 둘은 완전히
// 클라이언트 전용 계산(_stepMonthlyBase()/calcStandardPayslip(), public/index.html)에만
// 쓰이고 server.js에는 필드명 참조가 0건이다 — 즉 서버에는 "이 두 필드가 존재한다"는 인식
// 자체가 없고, settings(SINGLETON_FIELDS)에 대한 유일한 서버측 방어선은
// preserveServerOwnedStateForNonAdmin()의 "non-admin이 보낸 settings는 통째로 저장본으로
// 되돌린다" allow-list 모델뿐이다(이 코드베이스의 어떤 singleton 필드도 필드별 값 검증을
// 받지 않는 것이 일관된 기존 아키텍처 — _validateFieldValues()는 GENERIC_LIST_FIELDS의
// 레코드 단위 배열에만 적용되고 singleton엔 적용되지 않는다).
//
// 2026-10-14 종합 재점검(작업6)이 "payBasisMode/호봉제 서버측 테스트 커버리지가 0건"으로
// 플래그한 공백을 메우는 파일 — 급여계산이라는 민감 영역이라, 이 필드 쌍에 대해 기존
// generic 보호가 실제로 동작함을 명시적으로 고정해둔다(일반 settings 보호는
// test/api-nonadmin-state-preservation.test.js에서 이미 evilPolicy 예시로 검증돼 있지만,
// payBasisMode/salaryStepTable이라는 이 특정 필드 쌍을 이름으로 지목해 회귀를 바로 잡아내는
// 전용 테스트는 없었다).
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
async function login(api, loginId, pw) {
  const r = await (await api("/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ loginId, pw }),
  })).json();
  assert.equal(r.ok, true, `${loginId} 로그인 실패: ${JSON.stringify(r)}`);
  return r.token;
}

test("settings.payBasisMode/salaryStepTable — admin 라운드트립 + non-admin 위조 방어", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const api = (path, options) => fetch(server.baseUrl + path, options);

  const boot = await bootstrapAdminAndLogin(server, { loginId: "admin", pw: "admin-test-pw-1", name: "관리자" });
  const adminToken = boot.token;
  const initial = await getData(api, adminToken);

  const employees = [
    ...initial.data.employees,
    { id: "mem1", loginId: "mem1", pw: "mem1-pw-1", name: "팀원1", role: "member", active: true, dept: "개발본부", team: "A팀" },
  ];
  const seed = await api("/save", auth(adminToken, "POST", {
    _version: initial.version, employees,
    settings: { stage: "goal", evalYear: 2026, payBasisMode: "annual", salaryStepTable: {} },
  }));
  assert.equal(seed.status, 200);
  const mem1Token = await login(api, "mem1", "mem1-pw-1");

  await t.test("admin이 호봉제로 전환하고 호봉표를 저장하면 그대로 반영된다", async () => {
    const d = await getData(api, adminToken);
    const r = await api("/save", auth(adminToken, "POST", {
      _version: d.version,
      settings: { ...d.data.settings, payBasisMode: "step", salaryStepTable: { "대리": [3000000, 3200000, 3400000] } },
    }));
    assert.equal(r.status, 200);
    const check = await getData(api, adminToken);
    assert.equal(check.data.settings.payBasisMode, "step");
    assert.deepEqual(check.data.settings.salaryStepTable, { "대리": [3000000, 3200000, 3400000] });
  });

  await t.test("admin이 연봉제로 되돌려도 호봉표 자체는 지우지 않으면 보존된다(전환 시 데이터 손실 없음)", async () => {
    const d = await getData(api, adminToken);
    const r = await api("/save", auth(adminToken, "POST", {
      _version: d.version,
      settings: { ...d.data.settings, payBasisMode: "annual" },
    }));
    assert.equal(r.status, 200);
    const check = await getData(api, adminToken);
    assert.equal(check.data.settings.payBasisMode, "annual");
    assert.deepEqual(check.data.settings.salaryStepTable, { "대리": [3000000, 3200000, 3400000] });
  });

  await t.test("non-admin(member)이 /save로 payBasisMode/salaryStepTable을 직접 위조해도 저장본으로 되돌려진다", async () => {
    const d = await getData(api, mem1Token);
    const forged = {
      ...d.data.settings,
      payBasisMode: "step",
      salaryStepTable: { "대리": [999999999, 999999999] },
    };
    const r = await api("/save", auth(mem1Token, "POST", { _version: d.version, settings: forged }));
    assert.equal(r.status, 200);

    const check = await getData(api, adminToken);
    // member가 뭘 보냈든 admin이 마지막으로 저장한 실제 값(annual + 기존 호봉표)이 그대로
    // 유지돼야 한다 — settings는 non-admin에게 통째로 되돌려지는 allow-list 필드이므로.
    assert.equal(check.data.settings.payBasisMode, "annual");
    assert.deepEqual(check.data.settings.salaryStepTable, { "대리": [3000000, 3200000, 3400000] });
  });

  await t.test("member가 위조를 시도한 같은 요청에 실린 무관한 필드(본인 프로필)는 과잉차단 없이 정상 반영된다", async () => {
    const d = await getData(api, mem1Token);
    const updatedEmployees = d.data.employees.map(e => e.id === "mem1"
      ? { ...e, address: "새주소(과잉차단 확인용)", updatedAt: new Date().toISOString() }
      : e);
    const r = await api("/save", auth(mem1Token, "POST", {
      _version: d.version,
      employees: updatedEmployees,
      settings: { ...d.data.settings, payBasisMode: "step" }, // 여전히 위조 시도
    }));
    assert.equal(r.status, 200);

    const check = await getData(api, adminToken);
    const mem1 = check.data.employees.find(e => e.id === "mem1");
    assert.equal(mem1.address, "새주소(과잉차단 확인용)", "settings 위조 방어가 무관한 employees 변경까지 막으면 안 된다");
    assert.equal(check.data.settings.payBasisMode, "annual", "settings 위조는 여전히 차단돼야 한다");
  });
});
