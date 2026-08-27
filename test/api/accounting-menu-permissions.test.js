"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer, bootstrapAdminAndLogin } = require("../support/start-server");

test("accounting menu permissions: server blocks direct reads and writes and preserves expense-lite", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  const boot = await bootstrapAdminAndLogin(server, {
    loginId: "menu_admin", pw: "menu_admin_pw", name: "메뉴권한관리자",
  });
  const auth = { Authorization: `Bearer ${boot.token}` };
  const api = (path, options = {}) => fetch(server.baseUrl + path, {
    ...options,
    headers: { ...auth, ...(options.headers || {}) },
  });

  // menuPerms가 없는 기존 계정은 호환성을 위해 기존처럼 접근 가능하다.
  let res = await api("/api/accounting/accounts");
  assert.equal(res.status, 200);

  const before = await (await api("/data")).json();
  const employees = before.data.employees.map(e => String(e.id) === String(boot.employee.id)
    ? { ...e, menuPerms: { "acct-accounts": false, "acct-vouchers": false, "inv-items": false, "pms-projects": false, "recruit-jobs": false } }
    : e
  );
  res = await api("/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ _version: before.version, data: { ...before.data, employees } }),
  });
  assert.equal(res.status, 200, "메뉴 권한 시드 저장 실패");

  // 동일 토큰이어도 서버가 매 요청 저장된 menuPerms를 확인하므로 즉시 차단돼야 한다.
  res = await api("/api/accounting/accounts");
  let json = await res.json();
  assert.equal(res.status, 403);
  assert.equal(json.code, "MENU_ACCESS_DENIED");
  assert.equal(json.menuId, "acct-accounts");

  res = await api("/api/accounting/vouchers");
  assert.equal(res.status, 403, "다른 회계 하위 리소스도 각각 차단돼야 함");

  for (const path of ["/api/erp/items", "/api/pms/projects", "/api/recruit/jobs"]) {
    res = await api(path);
    assert.equal(res.status, 403, `${path}도 메뉴 권한 우회 없이 차단돼야 함`);
  }

  // UI만 숨기고 POST/DELETE가 통과하면 누구나 API 직접호출로 회계 데이터를 조작할 수 있다.
  res = await api("/api/accounting/accounts", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: "DENIED", name: "우회 시도", type: "expense" }),
  });
  assert.equal(res.status, 403, "메뉴가 차단되면 회계 쓰기도 차단돼야 함");
  json = await res.json();
  assert.equal(json.code, "MENU_ACCESS_DENIED");

  // Express 기본 라우팅은 대소문자 구분이 꺼져 있으면 `/API/Accounting/Accounts`도
  // `/api/accounting/accounts` 라우트에 매칭한다. 이때 보안 미들웨어가 소문자 prefix만
  // 보면 회사 모듈 킬스위치와 개인 메뉴권한을 통째로 우회해 쓰기까지 성공할 수 있으므로
  // API-like 경로의 casing mismatch는 핸들러 도달 전 404(JSON)로 종료해야 한다.
  res = await api("/API/Accounting/Accounts", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: "CASEBYPASS", name: "대소문자 우회 시도", type: "expense" }),
  });
  json = await res.json();
  assert.equal(res.status, 404, "대소문자 변형 API 경로는 라우트/권한 체크 우회 대신 404여야 함");
  assert.equal(json.code, "API_PATH_CASE_MISMATCH");

  // 감사자 위조 방어는 허용된 상태에서도 유지돼야 한다. 권한을 다시 켠 뒤 요청 body의
  // user가 아닌 토큰 주체가 감사 이력에 기록되는지 검증한다.
  const allowedState = await (await api("/data")).json();
  const allowedEmployees = allowedState.data.employees.map(e => String(e.id) === String(boot.employee.id)
    ? { ...e, menuPerms: { "acct-accounts": true, "acct-vouchers": true } }
    : e
  );
  res = await api("/save", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ _version: allowedState.version, data: { ...allowedState.data, employees: allowedEmployees } }),
  });
  assert.equal(res.status, 200, "감사 위조 검증용 권한 복구 실패");

  const accountBodies = [
    { code: "T901", name: "테스트비용", type: "expense", user: "CEO 위장" },
    { code: "T902", name: "테스트미지급", type: "liability", user: "CEO 위장" },
  ];
  const accounts = [];
  for (const body of accountBodies) {
    res = await api("/api/accounting/accounts", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    assert.equal(res.status, 200);
    json = await res.json();
    accounts.push(json.account);
    assert.equal(json.account.history[0].user, "menu_admin", "감사자 이름은 요청 body가 아닌 토큰 주체여야 함");
  }
  res = await api("/api/accounting/vouchers", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      date: "2026-08-24", description: "감사자 위조 테스트", user: "CEO 위장",
      lines: [
        { accountId: accounts[0].id, debit: 100, credit: 0 },
        { accountId: accounts[1].id, debit: 0, credit: 100 },
      ],
    }),
  });
  assert.equal(res.status, 200);
  json = await res.json();
  assert.equal(json.voucher.createdBy, "menu_admin", "전표 작성자도 토큰 주체로 고정돼야 함");

  // 사업계획이 쓰는 최소 DTO는 회계 원장 조회가 아니므로 account 메뉴가 꺼져도 유지한다.
  res = await api("/api/accounting/accounts/expense-lite");
  json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.ok, true);
  assert.ok(json.accounts.every(a => Object.keys(a).every(k => ["id", "code", "name"].includes(k))));
});
