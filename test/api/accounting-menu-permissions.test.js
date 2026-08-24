"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer, bootstrapAdminAndLogin } = require("../support/start-server");

test("accounting menu permissions: server blocks direct bulk reads and preserves expense-lite", async (t) => {
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
    ? { ...e, menuPerms: { "acct-accounts": false, "acct-vouchers": false } }
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

  // 기존 급여/경비 자동 전표 호환을 위해 회계 write를 아직 menuPerms로 일괄 차단하지는
  // 않는다. 대신 요청 body의 user를 위조해 감사 이력을 바꾸는 것은 반드시 막아야 한다.
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
