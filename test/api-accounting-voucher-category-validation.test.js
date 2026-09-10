"use strict";

// 회계 고도화(2026-09-10) — 전표 유형(category, 기본값+커스텀 자유입력)과, 지금까지
// 서버 검증이 없었던 거래처 사업자등록번호·이메일 형식, 세금계산서 품목 수량/단가
// 검증(_validateItemLines, 기존에 견적서/발주서/구매요청만 쓰고 있었음)을 확인한다.
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

test("전표 유형(category) 기본값·커스텀 + 거래처/세금계산서 형식 검증", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const api = (path, options) => fetch(server.baseUrl + path, options);

  const boot = await bootstrapAdminAndLogin(server, { loginId: "admin", pw: "admin-test-pw-1", name: "관리자" });
  const token = boot.token;

  const cash = await (await api("/api/accounting/accounts", auth(token, "POST", {
    code: "C101", name: "현금", type: "asset", user: "admin",
  }))).json();
  const expense = await (await api("/api/accounting/accounts", auth(token, "POST", {
    code: "C511", name: "복리후생비", type: "expense", user: "admin",
  }))).json();
  assert.equal(cash.ok, true);
  assert.equal(expense.ok, true);

  await t.test("category 생략 시 general로 기본값 처리된다", async () => {
    const r = await (await api("/api/accounting/vouchers", auth(token, "POST", {
      date: "2026-01-05", description: "일반 전표",
      lines: [{ accountId: expense.account.id, debit: 10000, credit: 0 }, { accountId: cash.account.id, debit: 0, credit: 10000 }],
      user: "admin",
    }))).json();
    assert.equal(r.ok, true);
    assert.equal(r.voucher.category, "general");
  });

  await t.test("커스텀 category(기타 직접입력)가 그대로 저장된다(30자 초과분은 잘림)", async () => {
    const longCat = "가".repeat(50);
    const r = await (await api("/api/accounting/vouchers", auth(token, "POST", {
      date: "2026-01-06", description: "커스텀 유형 전표", category: longCat,
      lines: [{ accountId: expense.account.id, debit: 5000, credit: 0 }, { accountId: cash.account.id, debit: 0, credit: 5000 }],
      user: "admin",
    }))).json();
    assert.equal(r.ok, true);
    assert.equal(r.voucher.category, "가".repeat(30));
  });

  await t.test("category가 문자열이 아니면(예: 숫자) general로 안전하게 대체된다", async () => {
    const r = await (await api("/api/accounting/vouchers", auth(token, "POST", {
      date: "2026-01-07", description: "이상값 category", category: 12345,
      lines: [{ accountId: expense.account.id, debit: 3000, credit: 0 }, { accountId: cash.account.id, debit: 0, credit: 3000 }],
      user: "admin",
    }))).json();
    assert.equal(r.ok, true);
    assert.equal(r.voucher.category, "general");
  });

  await t.test("거래처 사업자등록번호 형식이 틀리면 거부되고, 올바르면(대시 유무 무관) 저장된다", async () => {
    const bad = await (await api("/api/accounting/partners", auth(token, "POST", {
      name: "형식오류거래처", type: "vendor", bizNo: "abc", user: "admin",
    }))).json();
    assert.equal(bad.ok, false);
    assert.match(bad.message, /사업자등록번호/);

    const withDash = await (await api("/api/accounting/partners", auth(token, "POST", {
      name: "정상거래처1", type: "vendor", bizNo: "123-45-67890", user: "admin",
    }))).json();
    assert.equal(withDash.ok, true);

    const noDash = await (await api("/api/accounting/partners", auth(token, "POST", {
      name: "정상거래처2", type: "vendor", bizNo: "1234567890", user: "admin",
    }))).json();
    assert.equal(noDash.ok, true);
  });

  await t.test("거래처 이메일 형식이 틀리면 거부되고, 비워두면 통과한다", async () => {
    const bad = await (await api("/api/accounting/partners", auth(token, "POST", {
      name: "이메일오류거래처", type: "customer", email: "not-an-email", user: "admin",
    }))).json();
    assert.equal(bad.ok, false);
    assert.match(bad.message, /이메일/);

    const empty = await (await api("/api/accounting/partners", auth(token, "POST", {
      name: "이메일없는거래처", type: "customer", user: "admin",
    }))).json();
    assert.equal(empty.ok, true);
  });

  await t.test("세금계산서 품목의 수량이 0 이하이거나 단가가 음수면 거부된다", async () => {
    const badQty = await (await api("/api/accounting/tax-invoices", auth(token, "POST", {
      issueDate: "2026-01-10", partnerName: "테스트거래처",
      items: [{ name: "품목A", qty: 0, unitPrice: 1000 }], user: "admin",
    }))).json();
    assert.equal(badQty.ok, false);
    assert.match(badQty.message, /수량/);

    const badPrice = await (await api("/api/accounting/tax-invoices", auth(token, "POST", {
      issueDate: "2026-01-10", partnerName: "테스트거래처",
      items: [{ name: "품목B", qty: 1, unitPrice: -500 }], user: "admin",
    }))).json();
    assert.equal(badPrice.ok, false);
    assert.match(badPrice.message, /단가/);

    const ok = await (await api("/api/accounting/tax-invoices", auth(token, "POST", {
      issueDate: "2026-01-10", partnerName: "테스트거래처",
      items: [{ name: "품목C", qty: 2, unitPrice: 10000 }], user: "admin",
    }))).json();
    assert.equal(ok.ok, true);
    assert.equal(ok.taxInvoice.supplyTotal, 20000);
  });
});
